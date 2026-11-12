import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createHarness } from './support/harness.ts'
import { isBvid } from '../src/server/infra/bili/video.ts'

/** MCP 与网页共用队列，所以这里断言的是「MCP 排进去的那条任务和轮询抓到的是同一条」 */

const VIEW = {
  bvid: 'BV1GJ411x7h7',
  cid: 137649199,
  title: '官方 MV',
  desc: '简介',
  pic: 'http://i0.hdslb.com/a.jpg',
  pubdate: 1_700_000_000,
  owner: { mid: 123, name: 'UP', face: 'http://i0.hdslb.com/f.jpg' },
  pages: [{ cid: 137649199, part: 'P1' }],
}

async function rig() {
  const harness = await createHarness()
  harness.fetch.on('/x/web-interface/view', { data: VIEW })
  harness.fetch.on('/x/player/wbi/v2', { data: { subtitle: { subtitles: [] } } })
  return harness
}

describe('MCP 手动排解析', () => {
  it('bvid 白名单只收 BV 前缀的 12 位', () => {
    assert.equal(isBvid('BV1GJ411x7h7'), true)
    assert.equal(isBvid('av123'), false)
    assert.equal(isBvid('BV1GJ411x7h'), false)
  })

  it('按 bvid 合成动态记录并落库，标题封面从 view 来', async () => {
    const h = await rig()
    const res = await h.server.services.manual.parse('BV1GJ411x7h7')
    assert.equal(res.ok, true)

    const update = h.deps.repos.updates.getByBvid('BV1GJ411x7h7')
    assert.equal(update?.title, '官方 MV')
    assert.equal(update?.cover, 'http://i0.hdslb.com/a.jpg')
    assert.equal(update?.dynId, 'manual-BV1GJ411x7h7')

    const job = h.deps.repos.jobs.getByBvid('BV1GJ411x7h7')
    assert.equal(job?.updateId, 'manual-BV1GJ411x7h7')
    await h.close()
  })

  it('同一个 bvid 再排不会多出一条任务，也不再打 B 站', async () => {
    const h = await rig()
    const first = await h.server.services.manual.parse('BV1GJ411x7h7')
    const second = await h.server.services.manual.parse('BV1GJ411x7h7')

    assert.equal(first.ok && first.value.kind, 'enqueued')
    assert.equal(second.ok && second.value.kind, 'reused')
    assert.equal(h.fetch.countOf('/x/web-interface/view'), 1)
    assert.equal(h.deps.repos.jobs.list({ limit: 50 }).length, 1)
    await h.close()
  })

  it('库里没有这条时 status 明确说 notFound，而不是给个空对象', async () => {
    const h = await createHarness()
    const res = h.server.services.manual.status('BV1GJ411x7h7')
    assert.equal(res.ok, false)
    assert.match(res.ok === false ? res.failure.message : '', /先调 bili_parse_video/)
    await h.close()
  })
})
