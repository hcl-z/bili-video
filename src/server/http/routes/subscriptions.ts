import { Hono } from 'hono'

import type { SubscriptionResult, SubscriptionsResponse, UpSearchResponse } from '#shared/contract/api.ts'
import {
  AddSubscriptionRequestSchema,
  PatchSubscriptionRequestSchema,
  UpSearchQuerySchema,
} from '#shared/contract/api.ts'
import type { SubscriptionService } from '../../app/subscriptions.ts'
import { errorBody } from '../errors.ts'
import { parseBody, statusOf } from '../parse.ts'

/** 订阅的增删改查。业务编排全在 app/subscriptions，这一层只做三件事： 解请求、把 Failure 翻成 HTTP 状态、回 JSON */
export function subscriptionRoutes(subs: SubscriptionService): Hono {
  const list = (): SubscriptionsResponse => ({ subs: subs.list() })

  return new Hono()
    .get('/', (c) => c.json(list()))

    .get('/search', async (c) => {
      const parsed = UpSearchQuerySchema.safeParse(c.req.query())
      if (!parsed.success) return c.json(errorBody('invalid-request', '请输入 UP 主名称'), 400)

      const result = await subs.resolve(parsed.data.q)
      if (!result.ok) {
        const f = result.failure
        return c.json(errorBody(f.kind, f.message), statusOf(f))
      }
      const body: UpSearchResponse = { items: result.value }
      return c.json(body)
    })

    .post('/', async (c) => {
      const parsed = await parseBody(c.req.raw, AddSubscriptionRequestSchema)
      if (!parsed.ok) return c.json(parsed.body, 400)

      const added = await subs.add(parsed.value.input)
      if (!added.ok) {
        const f = added.failure
        return c.json(errorBody(f.kind, f.message), statusOf(f))
      }

      const body: SubscriptionResult = added.value
      return c.json(body, 201)
    })

    .patch('/:uid', async (c) => {
      const parsed = await parseBody(c.req.raw, PatchSubscriptionRequestSchema)
      if (!parsed.ok) return c.json(parsed.body, 400)

      const sub = subs.setToggles(c.req.param('uid'), parsed.value)
      if (sub === null) return c.json(errorBody('not-found', '没有这个订阅'), 404)
      const body: SubscriptionResult = { sub, notice: null }
      return c.json(body)
    })

    .delete('/:uid', (c) => {
      subs.remove(c.req.param('uid'))
      return c.json(list())
    })

    /** 关注重试。写接口撞风控是常态，页面得有个「再试一次」而不是只能重新加一次 */
    .post('/:uid/follow', async (c) => {
      const uid = c.req.param('uid')
      const before = subs.get(uid)
      if (before === null) return c.json(errorBody('not-found', '没有这个订阅'), 404)

      const r = await subs.ensureFollowed([uid])
      const body: SubscriptionResult = { sub: subs.get(uid) ?? before, notice: r.notice }
      return c.json(body)
    })
}
