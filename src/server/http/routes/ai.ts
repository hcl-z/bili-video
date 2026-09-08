import { Hono } from 'hono'

import { PatchAiSettingsRequestSchema } from '#shared/contract/api.ts'
import type { AiService } from '../../app/ai.ts'
import { parseBody } from '../parse.ts'

/**
 * AI 与 ASR 的配置面。响应里的 apiKey 永远只有掩码 —— 明文出不了服务端，
 * 这条约束落在这一层而不是 SecretStore（服务端自己要拿明文去调模型）。
 */
export function aiRoutes(ai: AiService): Hono {
  return new Hono()
    .get('/', (c) => c.json(ai.settings()))
    .patch('/', async (c) => {
      const parsed = await parseBody(c.req.raw, PatchAiSettingsRequestSchema)
      if (!parsed.ok) return c.json(parsed.body, 400)
      return c.json(ai.patch(parsed.value))
    })
    .post('/test', async (c) => c.json(await ai.test()))
}
