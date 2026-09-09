import type { AuthSnapshot, AuthState } from '#shared/contract/api.ts'
import { fail, ok, type Result } from '#shared/contract/failure.ts'
import {
  MAX_REFRESH_ATTEMPTS,
  decideAuthAction,
  remainingMs,
  type AuthAction,
} from '../domain/auth.ts'
import type { BiliAuth } from '../ports/bili.ts'
import { errFields, failureFields } from '../log-fields.ts'
import type { Clock } from '../ports/clock.ts'
import type { CookieJar } from '../ports/cookie-jar.ts'
import type { EventBus } from '../ports/event-bus.ts'
import type { Logger } from '../ports/logger.ts'
import type { StateRepo } from '../ports/state.ts'

/**
 * 登录态的生命周期：扫码进来、到期前续上、续不上就明确转成「登录已失效」。
 *
 * 这里是整个系统里最不该「悄悄失败」的地方。登录挂了而没人知道，表现是推送
 * 慢慢就没了 —— 所以每一次状态变化都落一条日志、发一个事件、更新一份快照，
 * 三者缺一都会让排查变成猜。
 */

/** 2 秒一轮足够灵敏，又不至于把 passport 打疼。 */
export const POLL_INTERVAL_MS = 2_000
/** 一次登录最多换两张码；再不扫就该让人重新来一次，而不是无限刷。 */
export const MAX_QR_ROUNDS = 2
/** 二维码 180 秒有效。轮到这儿还没结果就换码，不再对着一张死码继续问。 */
const QR_TIMEOUT_MS = 180_000

export interface AuthLifecycleDeps {
  auth: BiliAuth
  cookies: CookieJar
  state: StateRepo
  clock: Clock
  events: EventBus
  logger: Logger
  /** 提前多少天续期，来自配置（用时读，改完立刻生效）。 */
  refreshThresholdMs: () => number
  /** 二维码怎么给人看。默认写 stdout；测试里换成收集。 */
  showQr: (art: string, url: string) => void
  /** 把 url 渲染成字符画。渲染是 infra 的事，这一层只知道「有人能画」。 */
  renderQr: (url: string) => Promise<string>
}

export class AuthLifecycle {
  private readonly deps: AuthLifecycleDeps
  private readonly logger: Logger
  private state: AuthState
  private lastError: string | null = null
  private checkedAt: number | null = null
  /** 当前那张待扫码的地址。系统页靠它把码画出来，不必回终端。 */
  private qrUrl: string | null = null
  /** 有一轮扫码正在等人。第二个请求不再出第二张码。 */
  private loggingIn = false

  constructor(deps: AuthLifecycleDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'auth' })
    // 有 cookie 就先当「登录着」，等第一次核对给出结论。
    this.state = deps.cookies.isEmpty() ? 'logged-out' : 'logged-in'
  }

  snapshot(): AuthSnapshot {
    const expiresAt = this.deps.cookies.earliestExpiry()
    return {
      state: this.state,
      uid: this.deps.state.get('auth-uid'),
      uname: this.deps.state.get('auth-uname'),
      expiresAt,
      remainingMs: remainingMs(expiresAt, this.deps.clock.now()),
      refreshFailures: this.refreshFailures(),
      checkedAt: this.checkedAt,
      lastError: this.lastError,
      qrUrl: this.qrUrl,
    }
  }

  /**
   * 从页面上开一轮扫码。不 await 登录本身 —— 扫码要等人，HTTP 请求不该挂在那儿。
   *
   * 页面之后靠 /api/system 的 state 和 qrUrl 看进展（登录态变化都会发 SSE 事件）。
   */
  beginLogin(): 'started' | 'in-progress' {
    if (this.loggingIn) return 'in-progress'
    void this.loginByQr().catch((err: unknown) => {
      this.logger.error(errFields(err), '扫码登录异常')
    })
    return 'started'
  }

  /**
   * 手动续期。不走 decideAuthAction —— 那是「该不该续」，这里是人已经点了「续一下」。
   *
   * 续不动的原因照原样返回，页面要显示它；成功后剩余有效期由快照给出。
   */
  async refreshNow(): Promise<Result<AuthSnapshot>> {
    if (this.deps.cookies.isEmpty()) {
      const message = '本地没有 cookie，先扫码登录'
      this.lastError = message
      return fail({ kind: 'auth-lost', code: null, message, retryAfterMs: null })
    }
    this.logger.info({ trigger: 'manual' }, 'cookie 续期开始')
    const refreshed = await this.deps.auth.refreshCookies()
    if (!refreshed.ok) {
      const failures = this.refreshFailures() + 1
      this.deps.state.set('refresh-failures', String(failures))
      this.lastError = refreshed.failure.message
      this.logger.warn(
        { trigger: 'manual', failures, ...failureFields(refreshed.failure) },
        'cookie 续期失败',
      )
      return fail(refreshed.failure)
    }
    this.deps.state.set('refresh-failures', '0')
    this.lastError = null
    this.checkedAt = this.deps.clock.now()
    this.transition('logged-in', '手动续期成功')
    return ok(this.snapshot())
  }

  /** 登录态是否可用。轮询任务每轮开始前问它一次，false 就直接跳过这一轮。 */
  isUsable(): boolean {
    return this.state === 'logged-in'
  }

  /**
   * 核对并在需要时续期。启动时跑一次，之后由 cron 定期跑。
   *
   * 返回做了什么，而不是 void：调用方（cron）要据此决定要不要停轮询。
   */
  async ensureFresh(): Promise<Result<AuthAction>> {
    const status = await this.deps.auth.status()
    if (!status.ok) {
      // 问不出来 ≠ 没登录。保持原状态，记下原因，让下一轮再试。
      this.lastError = status.failure.message
      this.logger.warn(failureFields(status.failure), '登录态核对失败')
      return fail(status.failure)
    }
    this.checkedAt = this.deps.clock.now()
    this.rememberWho(status.value.uid, status.value.uname)

    // 有 cookie 但 B 站说没登录：纯函数看不见这一层，必须在这里显式判掉，
    // 否则会因为「到期时间还早」判成 idle，然后带着废 cookie 一直轮询。
    if (!this.deps.cookies.isEmpty() && !status.value.loggedIn) {
      return this.giveUp('B 站说这套 cookie 没有登录，需要重新扫码')
    }

    const action = decideAuthAction({
      hasCookies: !this.deps.cookies.isEmpty(),
      expiresAt: status.value.expiresAt,
      serverSaysRefresh: status.value.needsRefresh,
      now: this.deps.clock.now(),
      thresholdMs: this.deps.refreshThresholdMs(),
      failedRefreshes: this.refreshFailures(),
    })

    switch (action.action) {
      case 'idle':
        this.transition('logged-in', action.reason)
        this.lastError = null
        return ok(action)
      case 'relogin':
        return this.giveUp(action.reason)
      case 'refresh':
        return this.runRefresh(action)
    }
  }

  /**
   * 出码 → 打印 → 轮询到终态。判据 9 的那条链就是这个方法。
   *
   * 轮询用注入的时钟 sleep，所以测试里推假响应就能走完全程，不用真等。
   */
  async loginByQr(): Promise<Result<AuthSnapshot>> {
    // 一次只出一张码：启动流程和页面上的「重新扫码」撞上时，后来的那个直接被挡回去。
    if (this.loggingIn) {
      return fail({ kind: 'transient', code: null, message: '已经有一张码在等人扫', retryAfterMs: null })
    }
    this.loggingIn = true
    try {
      return await this.runQrLogin()
    } finally {
      this.loggingIn = false
    }
  }

  private async runQrLogin(): Promise<Result<AuthSnapshot>> {
    for (let round = 0; round < MAX_QR_ROUNDS; round += 1) {
      const started = await this.deps.auth.startQrLogin()
      if (!started.ok) {
        this.lastError = started.failure.message
        this.qrUrl = null
        return fail(started.failure)
      }
      // 先记下地址再转状态：页面看到 waiting-scan 时码必须已经能取到。
      this.qrUrl = started.value.url
      this.transition('waiting-scan', '二维码已生成')
      this.deps.showQr(await this.deps.renderQr(started.value.url), started.value.url)

      const deadline = this.deps.clock.now() + QR_TIMEOUT_MS
      while (this.deps.clock.now() < deadline) {
        const polled = await this.deps.auth.pollQrLogin(started.value.qrcodeKey)
        if (!polled.ok) {
          this.lastError = polled.failure.message
          this.qrUrl = null
          this.logger.warn(failureFields(polled.failure), '扫码状态轮询失败')
          return fail(polled.failure)
        }
        switch (polled.value.state) {
          case 'pending':
            break
          case 'scanned':
            this.transition('scanned', '已扫码，等手机上确认')
            break
          case 'expired':
            this.logger.info({ round }, '二维码已过期，重新出码')
            break
          case 'confirmed':
            this.rememberWho(polled.value.uid, polled.value.uname)
            this.deps.state.set('refresh-failures', '0')
            this.lastError = null
            this.qrUrl = null
            this.checkedAt = this.deps.clock.now()
            this.transition('logged-in', `登录成功：${polled.value.uname}`)
            return ok(this.snapshot())
        }
        if (polled.value.state === 'expired') break
        await this.deps.clock.sleep(POLL_INTERVAL_MS)
      }
    }

    const message = `扫码超时：换过 ${MAX_QR_ROUNDS} 张码都没有完成确认`
    this.lastError = message
    this.qrUrl = null
    this.transition(this.deps.cookies.isEmpty() ? 'logged-out' : 'auth-lost', message)
    return fail({ kind: 'transient', code: null, message, retryAfterMs: null })
  }

  private async runRefresh(action: AuthAction): Promise<Result<AuthAction>> {
    this.logger.info({ trigger: 'auto', reason: action.reason }, 'cookie 续期开始')
    const refreshed = await this.deps.auth.refreshCookies()
    if (refreshed.ok) {
      this.deps.state.set('refresh-failures', '0')
      this.lastError = null
      this.transition('logged-in', '续期成功')
      return ok(action)
    }

    const failures = this.refreshFailures() + 1
    this.deps.state.set('refresh-failures', String(failures))
    this.lastError = refreshed.failure.message
    this.logger.warn({ trigger: 'auto', failures, ...failureFields(refreshed.failure) }, 'cookie 续期失败')

    // 到上限就转终态。继续重试只会一直失败，而「一直在重试」看起来像还活着。
    if (failures >= MAX_REFRESH_ATTEMPTS || refreshed.failure.kind === 'auth-lost') {
      return this.giveUp(`续期失败 ${failures} 次：${refreshed.failure.message}`)
    }
    return fail(refreshed.failure)
  }

  /**
   * 转「等人扫码」的终态：只有重新扫码能走出去。
   *
   * 一份 cookie 都没有时是 logged-out 而不是 auth-lost —— 全新安装什么都没丢，
   * 页面上写「登录已失效」会让人以为出了故障，然后去查一个不存在的问题。
   */
  private giveUp(reason: string): Result<AuthAction> {
    this.lastError = reason
    this.transition(this.deps.cookies.isEmpty() ? 'logged-out' : 'auth-lost', reason)
    return ok({ action: 'relogin', reason })
  }

  private transition(next: AuthState, reason: string): void {
    if (this.state === next) return
    const from = this.state
    this.state = next
    this.logger.info({ from, to: next, reason }, '登录态变更')
    this.deps.events.emit({ type: 'auth.changed', loggedIn: next === 'logged-in' })
  }

  private rememberWho(uid: string | null, uname: string | null): void {
    if (uid !== null) this.deps.state.set('auth-uid', uid)
    if (uname !== null && uname !== '') this.deps.state.set('auth-uname', uname)
  }

  private refreshFailures(): number {
    const raw = this.deps.state.get('refresh-failures')
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  }
}
