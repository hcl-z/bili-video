import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  LoginStartResponseSchema,
  QrResponseSchema,
  RefreshResponseSchema,
  StorageResponseSchema,
} from '#shared/contract/api.ts'
import type { BackupFile } from '../src/server/app/backup.ts'
import { FakeFetch } from './fakes/bili-fetch.ts'
import { createHarness } from './support/harness.ts'

/** 页面上的运维动作：出码、续期、改 cron、看占用、导备份 */

const FAR_FUTURE = 'Tue, 07 Sep 2027 12:00:00 GMT'

function waitingForScan(): FakeFetch {
  return new FakeFetch()
    .on('qrcode/generate', {
      data: {
        url: 'https://login.bilibili.com/h5-app/passport/login/scan?qrcode_key=qk-web',
        qrcode_key: 'qk-web',
      },
    })

    .onHang('qrcode/poll')
}

describe('系统页', () => {
  it('页面上开一轮扫码，二维码渲染成 SVG 回来', async () => {
    const h = await createHarness({ fetch: waitingForScan() })
    try {
      const started = LoginStartResponseSchema.parse(
        await (await h.server.app.request('/api/system/login', { method: 'POST' })).json(),
      )
      assert.equal(started.started, true)


      await new Promise((r) => setTimeout(r, 0))

      const res = await h.server.app.request('/api/system/qr')
      assert.equal(res.status, 200)
      const qr = QrResponseSchema.parse(await res.json())
      assert.match(qr.url, /qrcode_key=qk-web/)
      assert.match(qr.svg, /^<svg /)

      assert.equal(h.server.services.auth!.snapshot().state, 'waiting-scan')


      const again = LoginStartResponseSchema.parse(
        await (await h.server.app.request('/api/system/login', { method: 'POST' })).json(),
      )
      assert.equal(again.started, false)
    } finally {
      await h.close()
    }
  })

  it('手动续期成功后回新的剩余有效期，失败时把原因原样给出来', async () => {
    const fetch = new FakeFetch()
      .on('web-interface/nav', { data: { isLogin: true, mid: 1, uname: '小号' } })
      .on('cookie/info', { data: { refresh: true, timestamp: 1_757_000_000_000 } })
      // 续期链的第一步就走不通：没配 RSA 公钥。原因要原样回给页面
      .on('correspond/1', { raw: '<html></html>' })

    const h = await createHarness({
      fetch,
      cookies: [`SESSDATA=fake; Path=/; Domain=.bilibili.com; Expires=${FAR_FUTURE}`],
    })
    try {
      const res = await h.server.app.request('/api/system/refresh', { method: 'POST' })
      assert.equal(res.status, 200, '续不动是 200：这是续期没成，不是请求错了')
      const body = RefreshResponseSchema.parse(await res.json())
      assert.equal(body.ok, false)
      assert.ok((body.error ?? '').length > 0)
      assert.equal(body.auth.refreshFailures, 1)
      assert.equal(body.auth.remainingMs, Date.parse(FAR_FUTURE) - h.clock.now())
    } finally {
      await h.close()
    }
  })

  it('cron 改完立即生效，非法表达式当场被拒且不落库', async () => {
    const h = await createHarness()
    try {
      const bad = await h.server.app.request('/api/config/poll', {
        method: 'PATCH',
        body: JSON.stringify({ cron: '每两分钟' }),
        headers: { 'content-type': 'application/json' },
      })
      assert.equal(bad.status, 400)
      assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'invalid-cron')
      assert.notEqual(h.core.config.getSection('poll').cron, '每两分钟')

      h.server.services.poll.start()
      const before = h.clock.scheduled.map((s) => s.cron)
      assert.deepEqual(before, ['30 */2 * * * *'])

      const ok = await h.server.app.request('/api/config/poll', {
        method: 'PATCH',
        body: JSON.stringify({ cron: '15 */5 * * * *' }),
        headers: { 'content-type': 'application/json' },
      })
      assert.equal(ok.status, 200)
      // 立即生效 = 重新排了程，不用重启。
      assert.deepEqual(
        h.clock.scheduled.map((s) => s.cron),
        ['15 */5 * * * *'],
      )
    } finally {
      await h.close()
    }
  })

  it('给出数据库体积与条数，备份含五份数据且不带任何加密值', async () => {
    const h = await createHarness()
    try {
      h.core.secrets.set('llm-api-key', 'sk-super-secret')
      h.core.repos.subscriptions.upsert({
        uid: '111',
        name: 'UP-111',
        face: null,
        enableDynamic: true,
        enableVideo: true,
        enableAi: true,
      })
      h.core.repos.rules.add({
        scope: 'global',
        kind: 'keyword-deny',
        pattern: '恰饭',
        enabled: true,
      })

      const storage = StorageResponseSchema.parse(
        await (await h.server.app.request('/api/system/storage')).json(),
      )
      assert.ok(storage.dbBytes > 0, '真库在临时目录里，体积不该是 0')
      assert.equal(storage.updates, 0)
      assert.equal(storage.summaries, 0)

      const res = await h.server.app.request('/api/system/backup')
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename=".+\.json"/)
      const raw = await res.text()
      const backup = JSON.parse(raw) as BackupFile

      assert.equal(backup.kind, 'bili-video-backup')
      assert.equal(backup.subscriptions.length, 1)
      assert.equal(backup.rules.length, 1)
      assert.deepEqual(backup.updates, [])
      assert.deepEqual(backup.summaries, [])
      assert.equal(backup.config.poll.cron, '30 */2 * * * *')
      assert.ok(backup.note.join('').includes('master.key'))
      // 加密值一个都不许进去 —— 这份文件是要被随手丢进网盘的。
      assert.ok(!raw.includes('sk-super-secret'), 'apiKey 明文进了备份')
      assert.ok(!raw.includes('SESSDATA'), 'cookie 进了备份')
    } finally {
      await h.close()
    }
  })
})
