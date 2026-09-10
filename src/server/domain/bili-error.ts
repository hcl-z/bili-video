import type { Failure, FailureKind } from '#shared/contract/failure.ts'

/** B 站错误码的纯失败分类；未知错误码归为 fatal，避免不安全重试 */

/** 退避建议；null 表示不重试 */
export const RETRY_AFTER_MS: Record<FailureKind, number | null> = {

  'risk-control': 5 * 60_000,
  'rate-limit': 60_000,
  transient: 10_000,
  // 等人重新扫码。cron 应停，不是应等
  'auth-lost': null,
  fatal: null,
}


const CODE_KINDS = new Map<number, FailureKind>([
  [-101, 'auth-lost'], // 账号未登录
  [-111, 'auth-lost'], // csrf 校验失败：bili_jct 与 SESSDATA 不咬合
  [-352, 'risk-control'], // 风控校验失败
  [-403, 'risk-control'], // 访问权限不足（B 站这里给的其实是风控）
  [-412, 'risk-control'],
  [-509, 'rate-limit'],
  [-799, 'rate-limit'],
  [-400, 'fatal'],
  [-404, 'fatal'],
  [-110, 'fatal'],
])

const make = (kind: FailureKind, code: number | null, message: string): Failure => ({
  kind,
  code,
  message,
  retryAfterMs: RETRY_AFTER_MS[kind],
})


export function classifyBiliCode(code: number, message: string): Failure | null {
  if (code === 0) return null
  const kind = CODE_KINDS.get(code)
  if (kind !== undefined) return make(kind, code, message)
  // 未知码：保留原文，它是排查时唯一的线索
  return make('fatal', code, `未知错误码 ${code}：${message}`)
}

/** HTTP 层的失败（还没走到 B 站的业务码）。code 一律 null，别和业务码混为一谈。 */
export function classifyHttpStatus(status: number, message?: string): Failure {
  const msg = message ?? `HTTP ${status}`
  if (status === 412) return make('risk-control', null, msg) // B 站 WAF
  if (status === 429) return make('rate-limit', null, msg)
  if (status === 401) return make('auth-lost', null, msg)
  if (status === 403) return make('risk-control', null, msg)
  if (status >= 500) return make('transient', null, msg)
  return make('fatal', null, msg)
}

/**
 * 抛出来的东西 → 失败。fetch 的网络错误、超时、DNS 失败都在这儿收口，
 * 统一算 transient：本地网络抖一下不该让轮询停摆。
 */
export function classifyThrown(err: unknown): Failure {
  const message = err instanceof Error ? err.message : String(err)
  return make('transient', null, message)
}

/** 本地就能判定的终态失败（配置缺失、用法不对）。code 为 null —— 这不是 B 站给的码。 */
export function fatalFailure(message: string): Failure {
  return make('fatal', null, message)
}

/**
 * 本地就能判定的「没登录」（比如缺 bili_jct）。走 `make` 而不是手写字面量：
 * `retryAfterMs` 只有 RETRY_AFTER_MS 一个真相，手抄一份就会和表分头漂移。
 */
export function authLostFailure(message: string): Failure {
  return make('auth-lost', null, message)
}

/** 配置或用法异常归为 fatal，与网络异常的 transient 分类分离。 */
export function fatalFromThrown(err: unknown): Failure {
  return fatalFailure(err instanceof Error ? err.message : String(err))
}

/** 响应形状不对 → fatal。截一段原文带上，否则排查时只能猜 B 站到底回了什么。 */
export function shapeFailure(what: string, body: unknown): Failure {
  return fatalFailure(`${what} 响应形状不对：${JSON.stringify(body).slice(0, 200)}`)
}
