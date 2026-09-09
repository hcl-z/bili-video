import { Hono } from 'hono'

import type { HealthResponse } from '#shared/contract/api.ts'
import type { Ports } from '../../ports/index.ts'

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
