import { Hono } from 'hono'

import type { HealthResponse } from '#shared/contract/api.ts'
import type { Ports } from '../../ports/index.ts'

/**
 * 启动时间 + 版本。配 uptimeMs 一起看能判断进程有没有偷偷重启过 ——
 * 一个只跑在本地的常驻服务，「它还活着吗、活了多久」是最基本的问题。
 */
export function healthRoutes(ports: Ports, startedAt: number): Hono {
  return new Hono().get('/', (c) => {
    const now = ports.clock.now()
    const body: HealthResponse = {
      ok: true,
      version: ports.version,
      startedAt,
      uptimeMs: now - startedAt,
      now,
    }
    return c.json(body)
  })
}
