import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ReaderItemResponse, UpFeedResponse } from '#shared/contract/api.ts'
import type { SummaryJob } from '#shared/contract/job.ts'
import type { FakeResponse } from './fakes/bili-fetch.ts'
import { avItem, bili, llmOk, player, rig, ZH_TRACK } from './support/queue-rig.ts'
import { pubAt } from './support/time.ts'

/**
 * 阅读页的 UP 泳道：现拉空间流 + 手动排解析。
 *
 * 轮询只抓启动之后新发的，所以这条路径才是「历史投稿怎么进来」的答案。
 */

/** 一条老投稿（只在空间流里）+ 一条文字动态。 */
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
    // 聚合流给空页：这条老投稿只该从空间流翻到。
    const fetch = bili([llmOk], undefined, [])
    fetch.on('feed/space', space([HISTORY, WORD]))
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)

    const first = (await (await h.server.app.request('/api/ups/111/feed')).json()) as UpFeedResponse
    assert.equal(first.up.name, 'UP-111')
    assert.deepEqual(first.items.map((i) => i.dynId), ['801', '802'])
    const av = first.items[0]!
    // 库里没有，所以「从没抓到过」而不是「未总结但已入库」。
    assert.equal(av.inDb, false)
    assert.equal(av.state, 'none')
    assert.equal(av.bvid, 'BV1hist')
    assert.equal(av.title, '启动之前的老投稿')
    // 碎动态没有 bvid，状态标记不该像是在等什么。
    assert.equal(first.items[1]?.bvid, null)

    const queued = await h.server.app.request('/api/ups/111/items/801/parse', { method: 'POST' })
    assert.equal(queued.status, 200)
    assert.equal(((await queued.json()) as SummaryJob).bvid, 'BV1hist')
    await h.server.services.queue.drain()

    // 先落库再入队，所以总结拿到的是真标题而不是一串 BV 号。
    assert.equal(h.core.repos.updates.get('801')?.title, '启动之前的老投稿')
    assert.equal(h.core.repos.summaries.get('BV1hist')?.tldr, '这个视频讲清了一件事，并给出了结论。')

    const after = (await (await h.server.app.request('/api/ups/111/feed')).json()) as UpFeedResponse
    assert.equal(after.items[0]?.state, 'done')
    assert.equal(after.items[0]?.inDb, true)

    // 深链接：左栏没翻到那一页时右栏按 dynId 单独取一条。
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

    // 轮询把它入了库并标成被拦下（自动解析与推送因此跳过）。
    await h.server.services.poll.pollOnce()
    assert.equal(h.core.repos.updates.get('801')?.filtered, true)

    const feed = (await (await h.server.app.request('/api/ups/111/feed')).json()) as UpFeedResponse
    const item = feed.items[0]!
    // 拦的是自动解析与推送这两个动作，不是这条视频 —— 所以它就是「未解析」。
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
    // 不在订阅里就一个请求都不该发出去。
    assert.equal(fetch.countOf('host_mid=999'), 0)

    await h.close()
  })
})
