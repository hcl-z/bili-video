import { Hono } from 'hono'

import type { HealthResponse } from '#shared/contract/api.ts'
import type { ServerDeps } from '../../types/index.ts'

export function healthRoutes(deps: ServerDeps, startedAt: number): Hono {
  return new Hono().get('/', (c) => {
    const now = deps.clock.now()
    const body: HealthResponse = {
      ok: true,
      version: deps.version,
      startedAt,
      uptimeMs: now - startedAt,
      now,
    }
    return c.json(body)
  })
}
