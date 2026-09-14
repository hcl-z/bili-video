import { Hono } from 'hono'

import type { PromptSettingsResponse } from '#shared/contract/api.ts'
import { PatchPromptSettingsRequestSchema } from '#shared/contract/api.ts'
import { DEFAULT_PROMPT_TEMPLATE, PROMPT_VARIABLES } from '#shared/contract/prompt.ts'
import type { ServerDeps } from '../../types/index.ts'
import { parseBody } from '../parse.ts'

export function promptRoutes(deps: ServerDeps): Hono {
  const body = (): PromptSettingsResponse => {
    const custom = deps.config.getSection('prompt').template
    return {
      defaultTemplate: DEFAULT_PROMPT_TEMPLATE,
      customTemplate: custom,
      effectiveTemplate: custom ?? DEFAULT_PROMPT_TEMPLATE,
      source: custom === null ? 'default' : 'custom',
      variables: [...PROMPT_VARIABLES],
    }
  }

  return new Hono()
    .get('/', (c) => c.json(body()))
    .patch('/', async (c) => {
      const parsed = await parseBody(c.req.raw, PatchPromptSettingsRequestSchema)
      if (!parsed.ok) return c.json(parsed.body, 400)
      deps.config.setSection('prompt', parsed.value)
      deps.events.emit({ type: 'config.changed', section: 'prompt' })
      return c.json(body())
    })
}
