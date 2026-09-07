import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { after, describe, it } from 'node:test'

import { HealthResponseSchema } from '#shared/contract/api.ts'
import { createHarness } from './support/harness.ts'

describe('装配好的服务', () => {
  it('健康检查返回版本与启动时间', async () => {
    const h = await createHarness()
    after(() => h.close())

    const res = await h.server.app.request('/api/health')
    assert.equal(res.status, 200)

    const body = HealthResponseSchema.parse(await res.json())
    assert.equal(body.ok, true)
    assert.equal(body.version, 'test')
    assert.equal(body.startedAt, h.clock.now())
    assert.equal(body.uptimeMs, 0)
  })

  it('未知的 /api 路径返回结构化 404 而不是 HTML', async () => {
    const h = await createHarness()
    after(() => h.close())

    const res = await h.server.app.request('/api/nope')
    assert.equal(res.status, 404)
    assert.equal(res.headers.get('content-type')?.includes('application/json'), true)
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'not-found')
  })

  it('未捕获异常回 500 结构化 JSON，且带堆栈落进日志', async () => {
    const h = await createHarness()
    after(() => h.close())

    // 只回 500 不落日志，等于事故没有现场 —— 这个系统的卖点就是可观测性。
    h.server.app.get('/boom', () => {
      throw new Error('故意炸的')
    })

    const res = await h.server.app.request('/boom')
    assert.equal(res.status, 500)
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'internal')

    const logged = h.logger.lines.find((l) => l.level === 'error')
    assert.ok(logged, `没有 error 级日志：${JSON.stringify(h.logger.lines)}`)
    assert.equal((logged.obj as { path?: string }).path, '/boom')
    assert.ok(typeof (logged.obj as { stack?: string }).stack === 'string')
  })

  it('只监听回环地址', async () => {
    const h = await createHarness()
    after(() => h.close())

    const addr = await h.server.start()
    assert.equal(addr.address, '127.0.0.1')
    assert.ok(addr.port > 0)
  })
})

describe('托管前端产物', () => {
  // webRoot 传绝对路径时 serveStatic 会静默什么都不伺服（它只认相对 cwd 的路径）。
  // 那个 bug 只在真起进程时才看得出来，所以钉在这儿。
  it('静态资源与深链接都能拿到，/api 仍然走 JSON', async () => {
    const h = await createHarness({ webRoot: resolve('test/fixtures/web') })
    after(() => h.close())

    const css = await h.server.app.request('/assets/app.css')
    assert.equal(css.status, 200)
    assert.ok(css.headers.get('content-type')?.includes('text/css'))

    // 深链接落到 index.html，交给 react-router。
    const deep = await h.server.app.request('/summaries/BV1xx')
    assert.equal(deep.status, 200)
    assert.ok((await deep.text()).includes('FIXTURE_SPA'))

    // /api 下的未命中绝不能掉到 index.html 上 —— 那会让前端把 HTML 当 JSON 解。
    const api = await h.server.app.request('/api/nope')
    assert.equal(api.status, 404)
    assert.ok(api.headers.get('content-type')?.includes('application/json'))
  })
})
