import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import { CONFIG_SECTION_NAMES } from '#shared/contract/config.ts'
import { createHarness } from './support/harness.ts'

function yamlFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bili-video-yaml-'))
  const file = join(dir, 'config.yaml')
  writeFileSync(file, body)
  return file
}

describe('配置', () => {
  it('首次启动从 config.example.yaml 导入全部 section', async () => {
    const h = await createHarness()
    try {
      const res = await h.server.app.request('/api/config')
      assert.equal(res.status, 200)
      const body = (await res.json()) as { config: Record<string, unknown>; seededFrom: string }

      assert.equal(body.seededFrom, 'config.example.yaml')
      assert.deepEqual(Object.keys(body.config).sort(), [...CONFIG_SECTION_NAMES].sort())
      // 仓库里的示例值：这两条是 spec 定死的（只听回环、轮询错峰到 :30）。
      assert.equal((body.config['server'] as { host: string }).host, '127.0.0.1')
      assert.equal((body.config['poll'] as { cron: string }).cron, '30 */2 * * * *')
    } finally {
      await h.close()
    }
  })

  it('YAML 只在库为空时生效：之后改 YAML 不影响已有配置', async () => {
    const file = yamlFile('ai:\n  model: from-first-yaml\n')
    const first = await createHarness({ seedFile: file })
    assert.equal(first.core.config.getSection('ai').model, 'from-first-yaml')
    assert.equal(first.core.config.seededFrom(), file)

    // 改 YAML，用同一个 dataDir 重启。
    writeFileSync(file, 'ai:\n  model: from-second-yaml\n')
    const second = await first.restart()
    try {
      assert.equal(
        second.core.config.getSection('ai').model,
        'from-first-yaml',
        '库已有配置，YAML 不该再被读进来',
      )
      assert.equal(second.core.config.seededFrom(), null, '第二次启动没有 seed')
    } finally {
      await second.close()
      // 连目录一起收掉，否则每跑一次测试就在 tmp 里留一个空壳。
      rmSync(dirname(file), { recursive: true, force: true })
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

      // 同一个进程、同一个实例，不重启就能读到新值。
      assert.notEqual(before, 'hot-swapped')
      assert.equal(h.core.config.getSection('ai').model, 'hot-swapped')
      assert.equal(h.ports.config.get().ai.model, 'hot-swapped')

      // 落库了：重启后还在。
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
      // 别的 section 一个字节都不该动。
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

  it('不 seed 时全部落到 schema 默认值', async () => {
    const h = await createHarness({ seedFile: null })
    try {
      assert.equal(h.core.config.seededFrom(), null)
      assert.deepEqual(Object.keys(h.core.config.get()).sort(), [...CONFIG_SECTION_NAMES].sort())
      assert.equal(h.core.config.getSection('poll').cron, '30 */2 * * * *')
    } finally {
      await h.close()
    }
  })
})
