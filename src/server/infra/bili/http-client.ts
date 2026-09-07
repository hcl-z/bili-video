import { z } from 'zod'

import { fail, ok, type Failure, type Result } from '#shared/contract/failure.ts'
import {
  classifyBiliCode,
  classifyHttpStatus,
  classifyThrown,
  fatalFromThrown,
} from '../../domain/bili-error.ts'
import type { Clock } from '../../ports/clock.ts'
import type { CookieJar } from '../../ports/cookie-jar.ts'
import type { Logger } from '../../ports/logger.ts'

import type { BrowserIdentity } from './browser-identity.ts'
import { keyFromUrl, signWbi, type WbiKeys } from './wbi.ts'
import { TICKET_URL, parseTicketResponse, ticketFormBody, type WebTicket } from './ticket.ts'

/**
 * 所有对 B 站的请求都从这里出去。集中在一处的理由有三个：
 *
 * 1. 浏览器身份必须每个请求都一致（UA 与客户端提示头咬合），散落各处必然漂。
 * 2. 「命中风控 → 清 WBI key → 重取 ticket → 重试一次」只应实现一遍。
 * 3. 每个响应都要过错误码分类，不允许任何调用方裸 catch 混过去。
 */

export type FetchLike = typeof fetch

/** 每次用时读，所以工作台改完配置立刻生效。 */
export interface BiliHttpConfig {
  wbiMixinTable: readonly number[]
  ticket: { keyId: string; hmacKey: string }
}

export interface BiliHttpDeps {
  fetch: FetchLike
  identity: BrowserIdentity
  cookies: CookieJar
  clock: Clock
  logger: Logger
  config: () => BiliHttpConfig
}

export interface RequestOptions {
  /** 要不要签 WBI。签不上（没配混淆表）会直接返回 fatal，不发请求。 */
  wbi?: boolean
  /** B 站对 Referer 敏感，默认给 www 首页。 */
  referer?: string
  /** 关掉「风控重试一次」，续期链这种带副作用的调用不该被自动重放。 */
  noRetry?: boolean
}

/** WBI key 的兜底来源，也是「我是谁」的唯一权威接口。 */
export const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
const DEFAULT_REFERER = 'https://www.bilibili.com/'
/** WBI key 一天一换足够；B 站实际是按日轮换的。 */
const WBI_TTL_MS = 12 * 3_600_000

/** Result 的内部变体：失败时也留着 data。可以赋给 Result<T>，反之不行。 */
type Raw<T> = { ok: true; value: T } | { ok: false; failure: Failure; data?: unknown }

const EnvelopeSchema = z.object({
  code: z.number().int(),
  message: z.string().default(''),
  data: z.unknown().optional(),
})

const NavWbiSchema = z.object({
  wbi_img: z.object({ img_url: z.string(), sub_url: z.string() }),
})

export class BiliHttp {
  private readonly deps: BiliHttpDeps
  private readonly logger: Logger
  private wbiKeys: WbiKeys | null = null
  private ticket: WebTicket | null = null
  /** nav / ticket 的取用互相依赖，同时进来两个请求会白打两次网络。 */
  private pendingKeys: Promise<Result<WbiKeys>> | null = null

  constructor(deps: BiliHttpDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'bili-http' })
  }

  /** 供测试与「风控后重取」使用：把签名相关的缓存全丢掉。 */
  resetSigning(): void {
    this.wbiKeys = null
    this.ticket = null
  }

  async get<T>(
    url: string,
    params: Record<string, string | number> = {},
    opts: RequestOptions = {},
  ): Promise<Result<T>> {
    return this.withRiskRetry(opts, () => this.attemptGet<T>(url, params, opts))
  }

  /**
   * 取一个非 JSON 的页面（续期链里的 `correspond/1/<path>` 就是 HTML）。
   * 不过信封解析，但照样带身份、带 cookie、按 HTTP 状态分类。
   */
  async getText(url: string, opts: RequestOptions = {}): Promise<Result<string>> {
    let res: Response
    try {
      res = await this.deps.fetch(url, { method: 'GET', headers: this.headers(opts) })
    } catch (err) {
      return fail(classifyThrown(err))
    }
    const setCookie = res.headers.getSetCookie()
    if (setCookie.length > 0) this.deps.cookies.setFromResponse(setCookie, this.deps.clock.now())
    if (!res.ok) return fail(classifyHttpStatus(res.status, `${res.status} ${url}`))
    try {
      return ok(await res.text())
    } catch (err) {
      return fail(classifyThrown(err))
    }
  }

  async postForm<T>(
    url: string,
    form: Record<string, string>,
    opts: RequestOptions = {},
  ): Promise<Result<T>> {
    return this.withRiskRetry(opts, () =>
      this.send<T>(url, {
        method: 'POST',
        headers: {
          ...this.headers(opts),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
      }),
    )
  }

  /**
   * 判据 6 的那一次重试：风控是非终态，先假定是签名过期/ticket 失效，
   * 清掉后重取一次。第二次还是风控就交给调用方按 retryAfterMs 退避 ——
   * 在这里循环只会让风控越来越深。
   */
  private async withRiskRetry<T>(
    opts: RequestOptions,
    attempt: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const first = await attempt()
    if (first.ok || first.failure.kind !== 'risk-control' || opts.noRetry === true) return first

    this.logger.warn({ failure: first.failure }, '命中风控，清空签名 key 并重取 ticket 后重试一次')
    this.resetSigning()
    const refreshed = await this.refreshTicket()
    if (!refreshed.ok) {
      // 重取失败不改变结论：原始的风控失败才是调用方要退避的依据。
      this.logger.warn({ failure: refreshed.failure }, '重取 ticket 没成功，沿用原始风控失败')
      return first
    }
    return attempt()
  }

  private async attemptGet<T>(
    url: string,
    params: Record<string, string | number>,
    opts: RequestOptions,
  ): Promise<Result<T>> {
    let query: Record<string, string>
    if (opts.wbi === true) {
      const keys = await this.ensureWbiKeys()
      if (!keys.ok) return fail(keys.failure)
      try {
        query = signWbi(params, keys.value, this.deps.config().wbiMixinTable, this.nowSec())
      } catch (err) {
        // 签不上就别发：发出去换回 -352，会被当成风控白白退避。
        return fail(fatalFromThrown(err))
      }
    } else {
      query = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
    }

    const qs = new URLSearchParams(query).toString()
    return this.send<T>(qs === '' ? url : `${url}?${qs}`, {
      method: 'GET',
      headers: this.headers(opts),
    })
  }

  /**
   * 发一个请求并把结果化成 Result；异常也在这里被收成 transient。
   *
   * 失败分支额外带上 data（`Raw`）：nav 未登录会回 -101，但 wbi_img 就在 data 里 ——
   * 对取 WBI 密钥这件事来说那不算失败。对外的 get/postForm 只暴露 Result，
   * 这个后门仅限本类内部使用。
   */
  private async send<T>(url: string, init: RequestInit): Promise<Raw<T>> {
    let res: Response
    try {
      res = await this.deps.fetch(url, init)
    } catch (err) {
      this.logger.warn({ url, err: String(err) }, '请求发不出去')
      return fail(classifyThrown(err))
    }

    // Set-Cookie 先收：即使这次业务码是失败，B 站也可能顺手换了 buvid/ticket。
    const setCookie = res.headers.getSetCookie()
    if (setCookie.length > 0) this.deps.cookies.setFromResponse(setCookie, this.deps.clock.now())

    if (!res.ok) {
      const failure = classifyHttpStatus(res.status, `${res.status} ${url}`)
      this.logger.warn({ url, status: res.status, kind: failure.kind }, 'HTTP 层失败')
      return fail(failure)
    }

    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      return fail({
        kind: 'transient',
        code: null,
        message: `响应不是 JSON：${err instanceof Error ? err.message : String(err)}`,
        retryAfterMs: 10_000,
      })
    }

    const envelope = EnvelopeSchema.safeParse(body)
    if (!envelope.success) {
      return fail({
        kind: 'fatal',
        code: null,
        message: `响应不是 B 站信封格式：${JSON.stringify(body).slice(0, 200)}`,
        retryAfterMs: null,
      })
    }

    const failure = classifyBiliCode(envelope.data.code, envelope.data.message)
    if (failure !== null) {
      this.logger.warn({ url, code: failure.code, kind: failure.kind }, '业务码失败')
      return { ok: false, failure, data: envelope.data.data }
    }
    return ok(envelope.data.data as T)
  }

  private headers(opts: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.deps.identity.headers,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: opts.referer ?? DEFAULT_REFERER,
      origin: 'https://www.bilibili.com',
    }
    const cookie = this.deps.cookies.header()
    if (cookie !== '') headers['cookie'] = cookie
    return headers
  }

  private nowSec(): number {
    return Math.floor(this.deps.clock.now() / 1000)
  }

  /** 有效的 WBI key；过期或没有就去取。并发调用共享同一次取用。 */
  private async ensureWbiKeys(): Promise<Result<WbiKeys>> {
    const cached = this.wbiKeys
    if (cached !== null && this.deps.clock.now() - cached.fetchedAt < WBI_TTL_MS) return ok(cached)
    if (this.pendingKeys !== null) return this.pendingKeys

    const pending = this.fetchWbiKeys()
    this.pendingKeys = pending
    try {
      return await pending
    } finally {
      this.pendingKeys = null
    }
  }

  private async fetchWbiKeys(): Promise<Result<WbiKeys>> {
    // 先试 ticket：它一次请求同时给 ticket 和 WBI key。没配 key 就退回 nav。
    const viaTicket = await this.refreshTicket()
    if (viaTicket.ok && viaTicket.value.keys !== null) return ok(viaTicket.value.keys)

    const nav = await this.send<unknown>(NAV_URL, {
      method: 'GET',
      headers: this.headers({}),
    })
    // nav 未登录会回 -101，但 wbi_img 照样在 data 里 —— 那种失败对这里无所谓。
    const parsed = NavWbiSchema.safeParse(nav.ok ? nav.value : nav.data)
    if (!parsed.success) {
      return nav.ok
        ? fail({
            kind: 'fatal',
            code: null,
            message: 'nav 响应里没有 wbi_img，拿不到 WBI 密钥',
            retryAfterMs: null,
          })
        : fail(nav.failure)
    }
    const keys: WbiKeys = {
      imgKey: keyFromUrl(parsed.data.wbi_img.img_url),
      subKey: keyFromUrl(parsed.data.wbi_img.sub_url),
      fetchedAt: this.deps.clock.now(),
    }
    this.wbiKeys = keys
    return ok(keys)
  }

  /** 换一张 bili_ticket，顺手更新 WBI key。手里那张还没过期就直接用。 */
  private async refreshTicket(): Promise<Result<WebTicket>> {
    const held = this.ticket
    // 提前一分钟就当过期，免得请求正好卡在到期那一刻。
    if (held !== null && this.deps.clock.now() < held.expiresAt - 60_000) return ok(held)

    let form: string
    try {
      form = ticketFormBody(
        this.deps.config().ticket,
        this.nowSec(),
        this.deps.cookies.csrf() ?? '',
      )
    } catch (err) {
      return fail(fatalFromThrown(err))
    }

    // 直接走 send 而不是 withRiskRetry：这条路径自己就是风控重试链的一环，套一层会递归。
    const res = await this.send<unknown>(`${TICKET_URL}?${form}`, {
      method: 'POST',
      headers: { ...this.headers({}), 'content-type': 'application/x-www-form-urlencoded' },
    })
    if (!res.ok) return fail(res.failure)

    const parsed = parseTicketResponse(res.value, this.deps.clock.now())
    if (!parsed.ok) return parsed
    this.ticket = parsed.value
    if (parsed.value.keys !== null) this.wbiKeys = parsed.value.keys
    this.logger.info({ expiresAt: parsed.value.expiresAt }, '已换取 bili_ticket')
    return parsed
  }
}
