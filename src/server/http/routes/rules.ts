import { Hono } from 'hono'

import type { RulesResponse, TestRulesResponse } from '#shared/contract/api.ts'
import {
  AddRuleRequestSchema,
  PatchRuleRequestSchema,
  TestRulesRequestSchema,
} from '#shared/contract/api.ts'
import type { RuleService } from '../../app/rules.ts'
import { errorBody } from '../errors.ts'
import { parseBody, statusOf } from '../parse.ts'

export function ruleRoutes(rules: RuleService): Hono {
  const list = (): RulesResponse => ({
    rules: rules.list(),
    timeouts: Object.fromEntries([...rules.timeoutCounts()].map(([id, n]) => [String(id), n])),
  })

  return new Hono()
    .get('/', (c) => c.json(list()))

    .post('/', async (c) => {
      const parsed = await parseBody(c.req.raw, AddRuleRequestSchema)
      if (!parsed.ok) return c.json(parsed.body, 400)

      const added = rules.add(parsed.value)
      if (!added.ok) {
        const f = added.failure
        return c.json(errorBody(f.kind, f.message), statusOf(f))
      }
      return c.json(list(), 201)
    })

    .patch('/:id', async (c) => {
      const parsed = await parseBody(c.req.raw, PatchRuleRequestSchema)
      if (!parsed.ok) return c.json(parsed.body, 400)
      rules.setEnabled(Number(c.req.param('id')), parsed.value.enabled)
      return c.json(list())
    })

    .delete('/:id', (c) => {
      rules.remove(Number(c.req.param('id')))
      return c.json(list())
    })

    /** 样本测试框。只读，不落库。 */
    .post('/test', async (c) => {
      const parsed = await parseBody(c.req.raw, TestRulesRequestSchema)
      if (!parsed.ok) return c.json(parsed.body, 400)
      const body: TestRulesResponse = rules.probe(parsed.value)
      return c.json(body)
    })
}
