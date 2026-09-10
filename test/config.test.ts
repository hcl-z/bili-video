import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CONFIG_SECTION_NAMES } from '#shared/contract/config.ts'
import { createHarness } from './support/harness.ts'

describe('配置', () => {
  it('首次启动从内置默认值导入全部 section', async () => {
    const h = await createHarness()
    try {
      const res = await h.server.app.request('/api/config')
      assert.equal(res.status, 200)
      const body = (await res.json()) as Record<string, unknown>

      assert.deepEqual(Object.keys(body).sort(), [...CONFIG_SECTION_NAMES].sort())

      assert.equal((body['server'] as { host: string }).host, '127.0.0.1')
      assert.equal((body['poll'] as { cron: string }).cron, '30 */2 * * * *')
    } finally {
      await h.close()
    }
  })

  it('内置默认值只在库为空时导入，之后重启不覆盖已有配置', async () => {
    const first = await createHarness()
    first.core.config.setSection('ai', { ...first.core.config.getSection('ai'), model: 'saved-model' })

    const second = await first.restart()
    try {
      assert.equal(second.core.config.getSection('ai').model, 'saved-model')
    } finally {
      await second.close()
    }
  })

  it('老库缺整段配置时按内置默认值补上，已有的那几段不动', async () => {
    const first = await createHarness()
    first.core.config.setSection('ai', { ...first.core.config.getSection('ai'), model: 'saved' })

    first.core.db.exec("DELETE FROM app_config WHERE key = 'bili'")

    const second = await first.restart()
    try {
      assert.equal(
        second.core.config.getSection('bili').refreshThresholdDays,
        15,
        '缺的段要按内置默认值补齐',
      )
      assert.equal(second.core.config.getSection('ai').model, 'saved')
    } finally {
      await second.close()
    }
  })

  it('改数据库里的配置无需重启即生效', async () => {
    const h = await createHarness()
    try {
      const before = h.core.config.getSection('ai').model

      const res = await h.server.app.request('/api/config/ai', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'hot-swapped' }),
      })
      assert.equal(res.status, 200)

      // 同一个进程、同一个实例，不重启就能读到新值
      assert.notEqual(before, 'hot-swapped')
      assert.equal(h.core.config.getSection('ai').model, 'hot-swapped')
      assert.equal(h.deps.config.get().ai.model, 'hot-swapped')


      const again = await h.restart()
      assert.equal(again.core.config.getSection('ai').model, 'hot-swapped')
      await again.close()
    } catch (err) {
      await h.close()
      throw err
    }
  })

  it('PATCH 只合并传入的字段，同 section 的其他字段不动', async () => {
    const h = await createHarness()
    try {
      const before = h.core.config.getSection('ai')

      await h.server.app.request('/api/config/ai', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ temperature: 0.9 }),
      })

      const after = h.core.config.getSection('ai')
      assert.equal(after.temperature, 0.9)
      assert.equal(after.model, before.model)
      assert.deepEqual(after.chunk, before.chunk)

      assert.deepEqual(h.core.config.getSection('poll'), h.core.config.getSection('poll'))
    } finally {
      await h.close()
    }
  })

  it('onChange 只在写入后触发一次，并带上改了哪个 section', async () => {
    const h = await createHarness()
    try {
      const seen: string[] = []
      h.core.config.onChange((section) => seen.push(section))

      h.core.config.setSection('log', { ...h.core.config.getSection('log'), level: 'debug' })
      assert.deepEqual(seen, ['log'])
    } finally {
      await h.close()
    }
  })

  it('非法值被挡在边界外，库里的旧值不变', async () => {
    const h = await createHarness()
    try {
      const before = h.core.config.getSection('ai').temperature

      const res = await h.server.app.request('/api/config/ai', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ temperature: 'hot' }),
      })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error: { code: string } }
      assert.equal(body.error.code, 'invalid-config')
      assert.equal(h.core.config.getSection('ai').temperature, before)
    } finally {
      await h.close()
    }
  })

  it('不存在的 section 返回 404 而不是建出一条野配置', async () => {
    const h = await createHarness()
    try {
      const res = await h.server.app.request('/api/config/nope', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: 1 }),
      })
      assert.equal(res.status, 404)
      const body = (await res.json()) as { error: { code: string } }
      assert.equal(body.error.code, 'unknown-section')
      assert.equal(h.core.db.prepare("SELECT * FROM app_config WHERE key = 'nope'").get(), undefined)
    } finally {
      await h.close()
    }
  })

  it('首次启动总是写入内置默认值', async () => {
    const h = await createHarness()
    try {
      assert.deepEqual(Object.keys(h.core.config.get()).sort(), [...CONFIG_SECTION_NAMES].sort())
      assert.equal(h.core.config.getSection('poll').cron, '30 */2 * * * *')
    } finally {
      await h.close()
    }
  })
})
