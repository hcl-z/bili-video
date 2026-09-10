import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ReaderItemResponse, UpdatesResponse, UpFeedResponse } from '#shared/contract/api.ts'
import type { SummaryJob } from '#shared/contract/job.ts'
import type { FakeResponse } from './fakes/bili-fetch.ts'
import { avItem, bili, llmOk, player, rig, ZH_TRACK } from './support/queue-rig.ts'
import { pubAt } from './support/time.ts'




const HISTORY = avItem('BV1hist', '801', '启动之前的老投稿')
const WORD = {
  id_str: '802',
  type: 'DYNAMIC_TYPE_WORD',
  modules: {
    module_author: { mid: 111, name: 'UP-111', pub_ts: String(pubAt(-3600)) },
    module_dynamic: { desc: { text: '一条碎动态' }, major: null },
  },
}

const space = (items: unknown[]): FakeResponse => ({
  data: { items, has_more: false, offset: '', update_baseline: 'sp' },
})

describe('UP 空间流与手动解析', () => {
  it('列出该 UP 的视频与动态并带本地状态，手动排一条解析后跑完变「已总结」', async () => {

    const fetch = bili([llmOk], undefined, [])
    fetch.on('feed/space', space([HISTORY, WORD]))
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)

    const first = (await (await h.server.app.request('/api/ups/111/feed')).json()) as UpFeedResponse
    assert.equal(first.up.name, 'UP-111')
    assert.deepEqual(first.items.map((i) => i.dynId), ['801', '802'])
    const av = first.items[0]!

    assert.equal(av.inDb, false)
    assert.equal(av.state, 'none')
    assert.equal(av.bvid, 'BV1hist')
    assert.equal(av.title, '启动之前的老投稿')

    assert.equal(first.items[1]?.bvid, null)

    const queued = await h.server.app.request('/api/ups/111/items/801/parse', { method: 'POST' })
    assert.equal(queued.status, 200)
    assert.equal(((await queued.json()) as SummaryJob).bvid, 'BV1hist')
    await h.server.services.queue.drain()


    assert.equal(h.core.repos.updates.get('801')?.title, '启动之前的老投稿')
    const updates = (await (await h.server.app.request('/api/updates')).json()) as UpdatesResponse
    assert.deepEqual(updates.updates, [], '手动解析的视频不应进入动态流')
    assert.equal(h.core.repos.summaries.get('BV1hist')?.tldr, '这个视频讲清了一件事，并给出了结论。')

    const after = (await (await h.server.app.request('/api/ups/111/feed')).json()) as UpFeedResponse
    assert.equal(after.items[0]?.state, 'done')
    assert.equal(after.items[0]?.inDb, true)

    // 深链接：左栏没翻到那一页时右栏按 dynId 单独取单条
    const one = (await (await h.server.app.request('/api/updates/801')).json()) as ReaderItemResponse
    assert.equal(one.item.state, 'done')

    await h.close()
  })

  it('被规则拦下的视频在这儿不算一个状态，手动解析照样能排', async () => {
    const fetch = bili([llmOk], undefined, [HISTORY])
    fetch.on('feed/space', space([HISTORY]))
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    h.core.repos.rules.add({ scope: 'global', kind: 'keyword-deny', pattern: '老投稿', enabled: true })


    await h.server.services.poll.pollOnce()
    assert.equal(h.core.repos.updates.get('801')?.filtered, true)

    const feed = (await (await h.server.app.request('/api/ups/111/feed')).json()) as UpFeedResponse
    const item = feed.items[0]!

    assert.equal(item.state, 'none')
    assert.match(item.filterReason ?? '', /老投稿/)

    const queued = await h.server.app.request('/api/ups/111/items/801/parse', { method: 'POST' })
    assert.equal(queued.status, 200)
    await h.server.services.queue.drain()
    assert.equal(h.core.repos.summaries.get('BV1hist')?.tldr, '这个视频讲清了一件事，并给出了结论。')

    await h.close()
  })

  it('碎动态排不上解析，没订阅的 uid 也翻不了', async () => {
    const fetch = bili([llmOk], undefined, [])
    fetch.on('feed/space', space([WORD]))
    const { h } = await rig(fetch)

    const word = await h.server.app.request('/api/ups/111/items/802/parse', { method: 'POST' })
    assert.equal(word.status, 400)

    const stranger = await h.server.app.request('/api/ups/999/feed')
    assert.equal(stranger.status, 400)
    // 不在订阅里就一个请求都不应发出去
    assert.equal(fetch.countOf('host_mid=999'), 0)

    await h.close()
  })
})
