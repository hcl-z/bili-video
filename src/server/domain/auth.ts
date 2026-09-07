import type { Failure } from '#shared/contract/failure.ts'
import { classifyBiliCode } from './bili-error.ts'

/**
 * 登录态的纯逻辑：扫码轮询码分类 + 「该续期还是该重新扫码」的决策。零 IO。
 *
 * 把决策抽成纯函数是因为它的分支比它看起来多（服务端说要续 / 本地算快到期 / 已经过期 /
 * 续了几次都失败），而每条分支走错的代价都是「监听静默停摆」——
 * 那种 bug 要等到三天没收到推送才会被发现。
 */

/** 扫码轮询的四种状态。confirmed 之后 cookie 就在响应头里了。 */
export type QrPollResult =
  | { state: 'pending' }
  | { state: 'scanned' }
  | { state: 'expired' }
  | { state: 'confirmed' }
  | { state: 'failed'; failure: Failure }

export function classifyQrPoll(code: number, message: string): QrPollResult {
  switch (code) {
    case 0:
      return { state: 'confirmed' }
    case 86101:
      return { state: 'pending' }
    case 86090:
      return { state: 'scanned' }
    case 86038:
      return { state: 'expired' }
    default:
      // 不认识的码绝不当成 pending：那会让登录页永远转圈，最难查的一类 bug。
      return {
        state: 'failed',
        failure: classifyBiliCode(code, message) ?? {
          kind: 'fatal',
          code,
          message,
          retryAfterMs: null,
        },
      }
  }
}

/** 剩余有效期。null = 不知道；已过期是 0，不是负数（页面上负数是 bug 不是信息）。 */
export function remainingMs(expiresAt: number | null, now: number): number | null {
  if (expiresAt === null) return null
  return Math.max(0, expiresAt - now)
}

/** 提前 15 天开始续。B 站的 SESSDATA 有效期是月级，15 天给足了重试与「人在休假」的余量。 */
export const DEFAULT_REFRESH_THRESHOLD_MS = 15 * 86_400_000

/** 连续失败这么多次就认定续期这条路走不通，转「登录已失效」等人重新扫码。 */
export const MAX_REFRESH_ATTEMPTS = 3

export type AuthAction =
  /** 什么都不用做。 */
  | { action: 'idle'; reason: string }
  /** 走 cookie/info → correspond/1 → cookie/refresh → confirm/refresh 那条链。 */
  | { action: 'refresh'; reason: string }
  /** 登录态没了，等人扫码。**不再自动重试** —— 重试废 cookie 只会加深风控。 */
  | { action: 'relogin'; reason: string }

export interface AuthInput {
  hasCookies: boolean
  /** cookie 到期时间（epoch ms）；null = 不知道。 */
  expiresAt: number | null
  /** B 站 `cookie/info` 返回的 `data.refresh`。 */
  serverSaysRefresh: boolean
  now: number
  thresholdMs: number
  /** 连续失败的续期次数。成功一次就归零。 */
  failedRefreshes: number
}

export function decideAuthAction(input: AuthInput): AuthAction {
  if (!input.hasCookies) {
    return { action: 'relogin', reason: '本地没有 cookie，需要扫码登录' }
  }

  const left = remainingMs(input.expiresAt, input.now)
  if (left === 0) {
    // 已经过期了，续期链需要一个还活着的 cookie 才能走通，直接省掉这次请求。
    return { action: 'relogin', reason: 'cookie 已过期，续期链走不通了' }
  }

  const nearExpiry = left !== null && left <= input.thresholdMs
  if (!input.serverSaysRefresh && !nearExpiry) {
    return { action: 'idle', reason: 'cookie 还在有效期内' }
  }

  if (input.failedRefreshes >= MAX_REFRESH_ATTEMPTS) {
    // criterion：续期失败要转「登录已失效」，而不是继续无效重试。
    return {
      action: 'relogin',
      reason: `续期已连续失败 ${input.failedRefreshes} 次，转为登录已失效`,
    }
  }

  return {
    action: 'refresh',
    reason: input.serverSaysRefresh
      ? 'cookie/info 说该续期了'
      : `本地判断即将到期（剩 ${Math.floor((left ?? 0) / 86_400_000)} 天）`,
  }
}
