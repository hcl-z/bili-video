import { Hono } from 'hono'

import type {
  SubscriptionResult,
  SubscriptionsResponse,
} from '#shared/contract/api.ts'
import {
  AddSubscriptionRequestSchema,
  PatchSubscriptionRequestSchema,
} from '#shared/contract/api.ts'
import type { Failure } from '#shared/contract/failure.ts'
import type { SubscriptionService } from '../../app/subscriptions.ts'
import { errorBody, zodIssues } from '../errors.ts'
import { ZodError } from 'zod'

/**
 * 订阅的增删改查。业务编排全在 app/subscriptions，这一层只做三件事：
 * 解请求、把 Failure 翻成 HTTP 状态、回 JSON。
 */
export function subscriptionRoutes(subs: SubscriptionService): Hono {
  const list = (): SubscriptionsResponse => ({ subs: subs.list() })

  return new Hono()
    .get('/', (c) => c.json(list()))

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

    /** 关注重试。写接口撞风控是常态，页面得有个「再试一次」而不是只能重新加一遍。 */
    .post('/:uid/follow', async (c) => {
      const uid = c.req.param('uid')
      const before = subs.get(uid)
      if (before === null) return c.json(errorBody('not-found', '没有这个订阅'), 404)

      const r = await subs.ensureFollowed([uid])
      const body: SubscriptionResult = { sub: subs.get(uid) ?? before, notice: r.notice }
      return c.json(body)
    })
}

/** zod 在 HTTP 边界跑完，穿过去就是确定类型（「Parse, don't validate」的三处边界之一）。 */
async function parseBody<T>(
  req: Request,
  schema: { parse(v: unknown): T },
): Promise<{ ok: true; value: T } | { ok: false; body: ReturnType<typeof errorBody> }> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { ok: false, body: errorBody('invalid-request', '请求体必须是 JSON') }
  }
  try {
    return { ok: true, value: schema.parse(raw) }
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, body: errorBody('invalid-request', '入参校验失败', zodIssues(err)) }
    }
    throw err
  }
}

/** 失败分类 → HTTP 状态。分类是业务概念，状态码只是它在 HTTP 上的投影。 */
function statusOf(f: Failure): 400 | 401 | 429 | 502 {
  switch (f.kind) {
    case 'fatal':
      return 400
    case 'auth-lost':
      return 401
    case 'rate-limit':
    case 'risk-control':
      return 429
    case 'transient':
      return 502
  }
}

const failureBody = (f: Failure): [string, string] => [f.kind, f.message]
