import { Hono } from 'hono'

import type { AppConfig, ConfigSection } from '#shared/contract/config.ts'
import { CONFIG_SECTIONS } from '#shared/contract/config.ts'
import { assertAsrProviderAvailable, LocalAsrUnavailableError } from '../../domain/asr-provider.ts'
import type { ServerDeps } from '../../types/index.ts'
import { errorBody, zodIssues } from '../errors.ts'
import { ZodError } from 'zod'

const isSection = (s: string): s is ConfigSection => s in CONFIG_SECTIONS

/** 配置以数据库为真相，修改立即生效 */
export function configRoutes(deps: ServerDeps): Hono {
  const log = deps.logger.child({ mod: 'http' })
  const body = (): AppConfig => deps.config.get()

  return new Hono()
    .get('/', (c) => c.json(body()))
    .patch('/:section', async (c) => {
      const section = c.req.param('section')
      if (!isSection(section)) {
        return c.json(errorBody('unknown-section', `没有这个配置段：${section}`), 404)
      }

      const patch: unknown = await c.req.json().catch(() => null)
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        return c.json(errorBody('invalid-request', '请求体必须是一个对象'), 400)
      }

      // 合并语义：页面只发改动的字段，不必回传整段。
      const merged = { ...deps.config.getSection(section), ...patch }

      // cron 当场校验。写进库要等到下一次排程才炸，而那时候没人在看。
      const badCron = cronError(deps.clock.checkCron, merged)
      if (badCron !== null) {
        return c.json(errorBody('invalid-cron', `cron 表达式不合法：${badCron}`), 400)
      }

      try {
        const parsed = CONFIG_SECTIONS[section].parse(merged) as never
        if (section === 'asr') {
          assertAsrProviderAvailable(
            deps.runtime.isDocker,
            (parsed as { provider: 'mlx-audio' | 'openai-compat' | 'chat-audio' }).provider,
          )
        }
        deps.config.setSection(section, parsed)
      } catch (err) {
        if (err instanceof LocalAsrUnavailableError) {
          return c.json(errorBody('asr-provider-unavailable', err.message), 400)
        }
        if (err instanceof ZodError) {
          return c.json(errorBody('invalid-config', '配置校验失败', zodIssues(err)), 400)
        }
        throw err
      }

      deps.events.emit({ type: 'config.changed', section })
      log.info({ section, fields: Object.keys(patch) }, '配置已更新')
      return c.json(body())
    })
}

/** 只看 `cron` 这个字段名，于是 poll 和 health 都被盖住，以后加第三个也不用改这里。 */
function cronError(check: (cron: string) => string | null, merged: object): string | null {
  const value = (merged as { cron?: unknown }).cron
  return typeof value === 'string' ? check(value) : null
}
