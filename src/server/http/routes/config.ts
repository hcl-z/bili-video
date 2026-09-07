import { Hono } from 'hono'

import type { ConfigResponse } from '#shared/contract/api.ts'
import { CONFIG_SECTIONS, type ConfigSection } from '#shared/contract/config.ts'
import type { Ports } from '../../ports/index.ts'
import { errorBody, zodIssues } from '../errors.ts'
import { ZodError } from 'zod'

const isSection = (s: string): s is ConfigSection => s in CONFIG_SECTIONS

/**
 * 配置以数据库为真相，改完立刻生效、不重启。`seededFrom` 是页面上那句
 * 「配置已由 Web 管理，config.yaml 不再生效」的依据。
 */
export function configRoutes(ports: Ports): Hono {
  const body = (): ConfigResponse => ({
    config: ports.config.get(),
    seededFrom: ports.config.seededFrom(),
  })

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
      const merged = { ...ports.config.getSection(section), ...patch }
      try {
        ports.config.setSection(section, CONFIG_SECTIONS[section].parse(merged) as never)
      } catch (err) {
        if (err instanceof ZodError) {
          return c.json(errorBody('invalid-config', '配置校验失败', zodIssues(err)), 400)
        }
        throw err
      }

      ports.events.emit({ type: 'config.changed', section })
      ports.logger.info({ section }, '配置已更新')
      return c.json(body())
    })
}
