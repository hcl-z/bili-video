import { z } from 'zod'

import { fail, ok, type Result } from '#shared/contract/failure.ts'
import { classifyQrPoll } from '../../domain/auth.ts'
import { fatalFromThrown, shapeFailure } from '../../domain/bili-error.ts'
import type { AuthStatus, BiliAuth, QrLogin, QrLoginState } from '../../ports/bili.ts'
import type { Clock } from '../../ports/clock.ts'
import type { CookieJar } from '../../ports/cookie-jar.ts'
import type { Logger } from '../../ports/logger.ts'
import { failureFields } from '../../log-fields.ts'

// NAV_URL 只定义一处：http 层取 WBI key 时也要用它，两份常量必然有一天对不上。
import { NAV_URL, type BiliHttp } from './http-client.ts'
import {
  correspondPath,
  parseCookieInfo,
  parseRefreshCsrf,
  parseRefreshResult,
} from './refresh.ts'

/**
 * 扫码登录 + cookie 续期。
 *
 * 这里唯一在意的事情是：**登录态的每一次变化都必须是显式的**。
 * 「不知道自己有没有登录」比「知道自己没登录」糟得多 —— 后者会去扫码，
 * 前者会带着废 cookie 一直轮询，直到某天有人发现推送早就停了。
 */

export const QR_GENERATE_URL =
  'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
export const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
export const COOKIE_INFO_URL = 'https://passport.bilibili.com/x/passport-login/web/cookie/info'
export const COOKIE_REFRESH_URL =
  'https://passport.bilibili.com/x/passport-login/web/cookie/refresh'
export const CONFIRM_REFRESH_URL =
  'https://passport.bilibili.com/x/passport-login/web/confirm/refresh'
const CORRESPOND_URL = 'https://www.bilibili.com/correspond/1/'

/** refresh_token 是凭据，落库要加密 —— 所以存取由外面注入，这里不认识 SQLite。 */
export interface TokenStore {
  get(): string | null
  set(token: string | null): void
}

export interface BiliAuthConfig {
  correspondPublicKeyPem: string
}

export interface BiliAuthDeps {
  http: BiliHttp
  cookies: CookieJar
  clock: Clock
  logger: Logger
  config: () => BiliAuthConfig
  /**
   * refresh_token 存哪儿。**必填**：给它一个进程内的默认实现看着方便，
   * 代价是重启后续期链静默失效 —— 那种「一个月后才发现要重新扫码」的 bug 不值得省这几行。
   */
  tokens: TokenStore
}

const QrGenerateSchema = z.object({ url: z.string().min(1), qrcode_key: z.string().min(1) })
const QrPollSchema = z.object({
  code: z.number().int(),
  message: z.string().default(''),
  refresh_token: z.string().optional(),
})
const NavSchema = z.object({
  isLogin: z.boolean().default(false),
  mid: z.number().int().optional(),
  uname: z.string().optional(),
})

export class BiliAuthClient implements BiliAuth {
  private readonly deps: BiliAuthDeps
  private readonly logger: Logger
  private readonly tokens: TokenStore

  constructor(deps: BiliAuthDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'bili-auth' })
    this.tokens = deps.tokens
  }

  async startQrLogin(): Promise<Result<QrLogin>> {
    const res = await this.deps.http.get<unknown>(QR_GENERATE_URL)
    if (!res.ok) return fail(res.failure)
    const parsed = QrGenerateSchema.safeParse(res.value)
    if (!parsed.success) return fail(shapeFailure('qrcode/generate', res.value))
    return ok({ qrcodeKey: parsed.data.qrcode_key, url: parsed.data.url })
  }

  /**
   * 轮询一次。注意这里有两层 code：外层信封的 code 恒为 0，
   * 真正的扫码状态在 `data.code` 里 —— 只看外层会觉得「一直成功」。
   */
  async pollQrLogin(qrcodeKey: string): Promise<Result<QrLoginState>> {
    const res = await this.deps.http.get<unknown>(POLL_URL, { qrcode_key: qrcodeKey })
    if (!res.ok) return fail(res.failure)
    const parsed = QrPollSchema.safeParse(res.value)
    if (!parsed.success) return fail(shapeFailure('qrcode/poll', res.value))

    const state = classifyQrPoll(parsed.data.code, parsed.data.message)
    if (state.state === 'failed') return fail(state.failure)
    if (state.state !== 'confirmed') return ok({ state: state.state })

    // 到这里 cookie 已经由 http 层从 Set-Cookie 收进 jar 了。
    if (parsed.data.refresh_token !== undefined) {
      this.tokens.set(parsed.data.refresh_token)
    } else {
      // 不是致命问题：登录能用，只是到期后续不了，只能重新扫码。说清楚就行。
      this.logger.warn({}, '登录成功但缺少 refresh_token，到期后须重新扫码')
    }

    const who = await this.whoAmI()
    if (!who.ok) return fail(who.failure)
    if (who.value.uid === null) {
      return fail({
        kind: 'auth-lost',
        code: null,
        message: '扫码确认了，但 nav 说没登录：cookie 没有生效',
        retryAfterMs: null,
      })
    }
    this.logger.info({ uid: who.value.uid, uname: who.value.uname }, '扫码登录成功')
    return ok({ state: 'confirmed', uid: who.value.uid, uname: who.value.uname ?? '' })
  }

  async status(): Promise<Result<AuthStatus>> {
    // 没有 cookie 就不必问 B 站 —— 答案已经确定了。
    if (this.deps.cookies.isEmpty()) {
      return ok({ loggedIn: false, uid: null, uname: null, expiresAt: null, needsRefresh: false })
    }

    const who = await this.whoAmI()
    if (!who.ok) return fail(who.failure)

    const info = await this.cookieInfo()
    if (!info.ok) return fail(info.failure)

    return ok({
      loggedIn: who.value.uid !== null,
      uid: who.value.uid,
      uname: who.value.uname,
      expiresAt: this.deps.cookies.earliestExpiry(),
      needsRefresh: info.value.refresh,
    })
  }

  /**
   * cookie/info → correspond/1 → cookie/refresh → confirm/refresh。
   *
   * 任一步失败都返回失败并保持旧 cookie 不动：换到一半的 cookie 比旧 cookie 更糟。
   * 唯一的例外是最后一步 confirm，它失败只意味着旧 token 没被吊销，新 cookie 已经能用了。
   */
  async refreshCookies(): Promise<Result<void>> {
    const csrf = this.deps.cookies.csrf()
    if (csrf === null) {
      return fail({
        kind: 'auth-lost',
        code: null,
        message: '本地没有 bili_jct，续期链走不了',
        retryAfterMs: null,
      })
    }
    const oldToken = this.tokens.get()
    if (oldToken === null) {
      return fail({
        kind: 'auth-lost',
        code: null,
        message: '没有 refresh_token（可能是旧版本登录留下的），只能重新扫码',
        retryAfterMs: null,
      })
    }

    const info = await this.cookieInfo()
    if (!info.ok) return fail(info.failure)
    const timestamp = info.value.timestamp ?? this.deps.clock.now()

    let path: string
    try {
      path = correspondPath(this.deps.config().correspondPublicKeyPem, timestamp)
    } catch (err) {
      return fail(fatalFromThrown(err))
    }

    const page = await this.deps.http.getText(`${CORRESPOND_URL}${path}`)
    if (!page.ok) return fail(page.failure)
    const refreshCsrf = parseRefreshCsrf(page.value)
    if (refreshCsrf === null) {
      return fail({
        kind: 'auth-lost',
        code: null,
        message: 'correspond 页面里没有 refresh_csrf，通常意味着 cookie 已经失效',
        retryAfterMs: null,
      })
    }

    // noRetry：这一步有副作用（B 站会换掉 cookie），自动重放会把状态搞乱。
    const refreshed = await this.deps.http.postForm<unknown>(
      COOKIE_REFRESH_URL,
      { csrf, refresh_csrf: refreshCsrf, source: 'main_web', refresh_token: oldToken },
      { noRetry: true },
    )
    if (!refreshed.ok) return fail(refreshed.failure)
    const result = parseRefreshResult(refreshed.value)
    if (!result.ok) return fail(result.failure)

    // 新 cookie 已经进 jar（http 层收的），新 token 存下来。
    this.tokens.set(result.value.refreshToken)

    const newCsrf = this.deps.cookies.csrf() ?? csrf
    const confirmed = await this.deps.http.postForm<unknown>(
      CONFIRM_REFRESH_URL,
      { csrf: newCsrf, refresh_token: oldToken },
      { noRetry: true },
    )
    if (!confirmed.ok) {
      // 新 cookie 已经能用了，只是旧 token 没吊销。记一笔，不把整次续期判为失败。
      this.logger.warn(failureFields(confirmed.failure), '续期确认失败，旧 token 未吊销')
    }
    this.logger.info({ expiresAt: this.deps.cookies.earliestExpiry() }, 'cookie 续期完成')
    return ok(undefined)
  }

  private async whoAmI(): Promise<Result<{ uid: string | null; uname: string | null }>> {
    const res = await this.deps.http.get<unknown>(NAV_URL)
    if (!res.ok) {
      // -101 是答案本身（没登录），不是故障。
      if (res.failure.kind === 'auth-lost') return ok({ uid: null, uname: null })
      return fail(res.failure)
    }
    const parsed = NavSchema.safeParse(res.value)
    if (!parsed.success) return fail(shapeFailure('nav', res.value))
    if (!parsed.data.isLogin || parsed.data.mid === undefined) {
      return ok({ uid: null, uname: null })
    }
    return ok({ uid: String(parsed.data.mid), uname: parsed.data.uname ?? null })
  }

  private async cookieInfo() {
    const res = await this.deps.http.get<unknown>(COOKIE_INFO_URL, {
      csrf: this.deps.cookies.csrf() ?? '',
    })
    if (!res.ok) return fail<{ refresh: boolean; timestamp?: number }>(res.failure)
    return parseCookieInfo(res.value)
  }
}

