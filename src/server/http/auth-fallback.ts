import type { AuthSnapshot } from '#shared/contract/api.ts'
import { remainingMs } from '../domain/auth.ts'
import type { ServerDeps } from '../types/index.ts'

export const ADAPTER_MISSING = 'B 站适配器未接入（本进程没有装配 biliAuth）'

/** B 站适配器还没接上时的登录态。不是「没登录」，而是「这个能力没装」—— 但对页面来说结论一样：不能干活，且原因写在 lastError 里，不留无效 */
export function adapterMissingAuth(deps: ServerDeps, now: number): AuthSnapshot {
  const expiresAt = deps.cookies.earliestExpiry()
  return {
    state: 'logged-out',
    uid: deps.state.get('auth-uid'),
    uname: deps.state.get('auth-uname'),
    expiresAt,
    remainingMs: remainingMs(expiresAt, now),
    refreshFailures: 0,
    checkedAt: null,
    lastError: ADAPTER_MISSING,
    qrUrl: null,
  }
}
