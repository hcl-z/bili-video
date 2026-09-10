import { Hono } from 'hono'

import type { UpFeedResponse } from '#shared/contract/api.ts'
import { UpFeedQuerySchema } from '#shared/contract/api.ts'
import type { UpFeedService } from '../../app/up-feed.ts'
import type { ServerDeps } from '../../types/index.ts'
import { errorBody, zodIssues } from '../errors.ts'
import { statusOf } from '../parse.ts'


export function upRoutes(deps: ServerDeps, ups: UpFeedService): Hono {
  return new Hono()
    .get('/:uid/feed', async (c) => {
      const q = UpFeedQuerySchema.safeParse(c.req.query())
      if (!q.success) return c.json(errorBody('invalid-request', '查询参数不对', zodIssues(q.error)), 400)

      const res = await ups.list(c.req.param('uid'), q.data.offset ?? null)
      if (!res.ok) {
        const f = res.failure
        return c.json(errorBody(f.kind, f.message), statusOf(f))
      }
      const body: UpFeedResponse = res.value
      return c.json(body)
    })

    .post('/:uid/items/:dynId/parse', async (c) => {
      if (!deps.config.getSection('ai').enabled) {
        return c.json(errorBody('conflict', 'AI 总开关关着，打开后才会跑'), 409)
      }

      const res = await ups.parse(c.req.param('uid'), c.req.param('dynId'))
      if (!res.ok) {
        const f = res.failure
        return c.json(errorBody(f.kind, f.message), statusOf(f))
      }
      return c.json(res.value)
    })
}
