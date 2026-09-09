import type { Failure } from '#shared/contract/failure.ts'
import { classifyBiliCode } from './bili-error.ts'

/**
 * 登录态纯逻辑：分类扫码轮询结果，并决策续期或重新扫码。
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
      // 未知状态码视为失败，避免登录页持续等待。
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

/** 提前 15 天续期，为重试预留时间。 */
export const DEFAULT_REFRESH_THRESHOLD_MS = 15 * 86_400_000

/** 连续失败这么多次就认定续期这条路走不通，转「登录已失效」等人重新扫码。 */
export const MAX_REFRESH_ATTEMPTS = 3

export type AuthAction =
  /** 什么都不用做。 */
  | { action: 'idle'; reason: string }
  /** 走 cookie/info → correspond/1 → cookie/refresh → confirm/refresh 那条链。 */
  | { action: 'refresh'; reason: string }
  /** 登录失效后等待扫码，不自动重试无效 cookie。 */
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
