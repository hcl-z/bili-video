import { Hono } from 'hono'

import type { PollResult, UpdatesResponse } from '#shared/contract/api.ts'
import { UpdatesQuerySchema } from '#shared/contract/api.ts'
import type { Poller } from '../../app/poller.ts'
import type { Ports } from '../../ports/index.ts'
import { errorBody, zodIssues } from '../errors.ts'

/** 更新流。列条目 + 手动催一轮轮询（等 2 分钟太久，页面上要有个「立刻抓」）。 */
export function updateRoutes(ports: Ports, poll: Poller): Hono {
  return new Hono()
    .get('/', (c) => {
      const q = UpdatesQuerySchema.safeParse(c.req.query())
      if (!q.success) {
        return c.json(errorBody('fatal', '查询参数不对', zodIssues(q.error)), 400)
      }
      const updates = ports.repos.updates.list({
        limit: q.data.limit,
        includeFiltered: q.data.filtered === '1',
        ...(q.data.uid === undefined ? {} : { uid: q.data.uid }),
        ...(q.data.before === undefined ? {} : { before: q.data.before }),
      })
      const body: UpdatesResponse = { updates, ups: {} }
      for (const s of ports.repos.subscriptions.list()) {
        body.ups[s.uid] = { name: s.name, face: s.face }
      }
      return c.json(body)
    })

    .post('/poll', async (c) => {
      const body: PollResult = await poll.pollOnce()
      return c.json(body)
    })
}
