import type { Failure, FailureKind } from '#shared/contract/failure.ts'

/**
 * B 站错误码 → 失败分类。纯函数，零 IO。
 *
 * 这是整个监听层最值钱的一张表（spec 附录：「抄。这是最值钱的部分」）。它错一格不会报错，
 * 只会安静地做错事：
 * - 把 risk-control 当 fatal → 系统一次风控之后再也不轮询，而它其实退避几分钟就恢复；
 * - 把 auth-lost 当 transient → 拿着废 cookie 疯狂重试，把小号送进更深的风控。
 *
 * 所以：**不认识的码归 fatal**。停下来让人看一眼，比自作聪明地重试安全。
 */

/** 退避建议。null = 别重试（重试不会让结果变好，只会加深风控）。 */
export const RETRY_AFTER_MS: Record<FailureKind, number | null> = {
  // 抄参考实现：-352/-403 非终态，退避 5 分钟重启。
  'risk-control': 5 * 60_000,
  'rate-limit': 60_000,
  transient: 10_000,
  // 等人重新扫码。cron 该停，不是该等。
  'auth-lost': null,
  fatal: null,
}

/**
 * 已知码表。只收**确认过含义**的码 —— 拿不准的宁可走 fatal 兜底，
 * 也不要写一个看起来很全、其实猜的表。
 */
const CODE_KINDS = new Map<number, FailureKind>([
  [-101, 'auth-lost'], // 账号未登录
  [-111, 'auth-lost'], // csrf 校验失败：bili_jct 与 SESSDATA 不咬合
  [-352, 'risk-control'], // 风控校验失败
  [-403, 'risk-control'], // 访问权限不足（B 站这里给的其实是风控）
  [-412, 'risk-control'], // 请求被拦截
  [-509, 'rate-limit'], // 请求过于频繁
  [-799, 'rate-limit'], // 请求过于频繁（另一个口径）
  [-400, 'fatal'], // 请求错误
  [-404, 'fatal'], // 啥都木有
  [-110, 'fatal'], // 未绑定手机，要人去处理
])

const make = (kind: FailureKind, code: number | null, message: string): Failure => ({
  kind,
  code,
  message,
  retryAfterMs: RETRY_AFTER_MS[kind],
})

/**
 * @returns null 表示 code 0（成功）。调用方必须显式处理这个 null —— 那正是
 *   「穷举失败分类」的入口。
 */
export function classifyBiliCode(code: number, message: string): Failure | null {
  if (code === 0) return null
  const kind = CODE_KINDS.get(code)
  if (kind !== undefined) return make(kind, code, message)
  // 未知码：保留原文，它是排查时唯一的线索。
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
 * 抛出来的**配置/用法**错误 → fatal。和 classifyThrown 分开是有意的：
 * 签名密钥没配、PEM 不合法这类问题重试一万次结果一样，算 transient 只会让它无声地转圈。
 */
export function fatalFromThrown(err: unknown): Failure {
  return fatalFailure(err instanceof Error ? err.message : String(err))
}

/** 响应形状不对 → fatal。截一段原文带上，否则排查时只能猜 B 站到底回了什么。 */
export function shapeFailure(what: string, body: unknown): Failure {
  return fatalFailure(`${what} 响应形状不对：${JSON.stringify(body).slice(0, 200)}`)
}
