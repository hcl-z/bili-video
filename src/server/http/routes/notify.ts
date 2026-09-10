import { Hono } from 'hono'

import {
  PatchNotifySettingsRequestSchema,
  type NotifyTestResponse,
} from '#shared/contract/api.ts'
import type { NotifyService } from '../../app/notify.ts'
import type { NotifyChannel } from '../../ports/notifier.ts'
import { errorBody } from '../errors.ts'
import { parseBody } from '../parse.ts'

const isChannel = (value: string): value is NotifyChannel =>
  value === 'wxpusher' ||
  value === 'pushplus' ||
  value === 'ntfy' || value === 'feishu' || value === 'webhook'

export function notifyRoutes(notify: NotifyService): Hono {
  return new Hono()
    .get('/', (c) => c.json(notify.settings()))
    .patch('/', async (c) => {
      const parsed = await parseBody(c.req.raw, PatchNotifySettingsRequestSchema)
      if (!parsed.ok) return c.json(parsed.body, 400)
      return c.json(notify.patch(parsed.value))
    })
    .post('/:channel/test', async (c) => {
      const channel = c.req.param('channel')
      if (!isChannel(channel)) {
        return c.json(errorBody('unknown-channel', `没有这个推送渠道：${channel}`), 404)
      }
      return c.json<NotifyTestResponse>(await notify.test(channel))
    })
}
