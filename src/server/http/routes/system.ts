import { Hono } from 'hono'

import type { AuthSnapshot, SystemResponse } from '#shared/contract/api.ts'
import type { AuthLifecycle } from '../../app/auth-lifecycle.ts'
import type { Poller } from '../../app/poller.ts'
import { remainingMs } from '../../domain/auth.ts'
import type { Ports } from '../../ports/index.ts'

/**
 * 系统状态。工作台首页靠它回答「现在能不能干活」：登录态、是谁、cookie 还有多久。
 *
 * 只读当前快照，不主动去问 B 站 —— 页面刷新不该顺手打一串外部请求。
 * 真正的核对由启动流程和 cron 做，这里看到的是它们留下的结论。
 */
export function systemRoutes(
  ports: Ports,
  startedAt: number,
  auth: AuthLifecycle | null,
  poll: Poller,
): Hono {
  return new Hono().get('/', (c) => {
    const now = ports.clock.now()
    const body: SystemResponse = {
      auth: auth === null ? adapterMissing(ports, now) : auth.snapshot(),
      poll: poll.snapshot(),
      version: ports.version,
      startedAt,
      uptimeMs: now - startedAt,
      now,
    }
    return c.json(body)
  })
}

/**
 * B 站适配器还没接上时的快照。不是「没登录」，而是「这个能力没装」——
 * 但对页面来说结论一样：不能干活，且原因写在 lastError 里，不留白。
 */
function adapterMissing(ports: Ports, now: number): AuthSnapshot {
  const expiresAt = ports.cookies.earliestExpiry()
  return {
    state: 'logged-out',
    uid: ports.state.get('auth-uid'),
    uname: ports.state.get('auth-uname'),
    expiresAt,
    remainingMs: remainingMs(expiresAt, now),
    refreshFailures: 0,
    checkedAt: null,
    lastError: 'B 站适配器未接入（本进程没有装配 biliAuth）',
  }
}
