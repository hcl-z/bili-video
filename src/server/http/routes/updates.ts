import { Hono } from 'hono'

import type { PollResult, ReaderItemResponse, UpdatesResponse } from '#shared/contract/api.ts'
import { UpdatesQuerySchema } from '#shared/contract/api.ts'
import type { Poller } from '../../app/poller.ts'
import type { Ports } from '../../ports/index.ts'
import { errorBody, zodIssues } from '../errors.ts'
import { fromUpdate } from '../reader-item.ts'

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

    /** 单条。阅读页深链接进来时右栏不用等左栏翻到那一页。 */
    .get('/:dynId', (c) => {
      const update = ports.repos.updates.get(c.req.param('dynId'))
      if (update === null) return c.json(errorBody('not-found', '库里没有这条动态'), 404)
      const body: ReaderItemResponse = { item: fromUpdate(ports, update) }
      return c.json(body)
    })
}
