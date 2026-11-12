import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createHarness } from './support/harness.ts'

/** 转写是主产物，AI 总结是可选的追加步骤。这里钉住两者互不牵连：LLM 挂了转写照拿。 */

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

const SUBTITLE_BODY = {
  body: [
    { from: 0.5, to: 3, content: '第一句' },
    { from: 3, to: 6, content: '第二句' },
  ],
}

const IMG = 'https://i0.hdslb.com/bfs/wbi/aaaaaaaabbbbbbbbccccccccdddddddd.png'
const SUB = 'https://i0.hdslb.com/bfs/wbi/11111111222222223333333344444444.png'

async function rig() {
  const harness = await createHarness()
  harness.core.config.setSection('bili', {
    ...harness.core.config.getSection('bili'),
    // 混淆表留空时签名直接报错，测试里给一份恒等表
    wbiMixinTable: Array.from({ length: 64 }, (_, i) => i),
  })
  // WBI 签名要先拿密钥，player/v2 是签名接口
  harness.fetch.on('/x/web-interface/nav', {
    data: { wbi_img: { img_url: IMG, sub_url: SUB } },
  })
  harness.fetch.on('/x/web-interface/view', { data: VIEW })
  harness.fetch.on('/x/player/wbi/v2', {
    data: {
      subtitle: {
        subtitles: [{ lan: 'zh-CN', lan_doc: '中文', ai_type: 0, subtitle_url: '//x/zh.json' }],
      },
    },
  })
  harness.fetch.on('/x/zh.json', { raw: SUBTITLE_BODY })
  harness.server.services.queue.start()
  return harness
}

describe('只取转写', () => {
  it('want=transcript 时跑完停在转写，不调 LLM，产物可查', async () => {
    const h = await rig()
    // AI 关着：要总结的任务一条都取不出来，只取转写的照跑
    h.deps.config.setSection('ai', { ...h.deps.config.getSection('ai'), enabled: false })

    const res = await h.server.services.manual.parse('BV1GJ411x7h7', { want: 'transcript' })
    assert.equal(res.ok, true)

    await h.server.services.queue.drain(5_000)

    const job = h.deps.repos.jobs.getByBvid('BV1GJ411x7h7')
    assert.equal(job?.status, 'done')
    assert.equal(job?.want, 'transcript')
    // 没有总结行，但转写拿到了
    assert.equal(h.deps.repos.summaries.get('BV1GJ411x7h7'), null)

    const t = h.server.services.manual.transcript('BV1GJ411x7h7')
    assert.equal(t.ok, true)
    assert.equal(t.ok && t.value?.source, 'subtitle')
    assert.equal(t.ok && t.value?.cueCount, 2)
    assert.match(t.ok && (t.value?.text ?? ''), /第一句/)
    assert.match(t.ok && (t.value?.text ?? ''), /\[00:03\]第二句/)
    await h.close()
  })

  it('AI 关着时，要总结的任务不会被取走', async () => {
    const h = await rig()
    h.deps.config.setSection('ai', { ...h.deps.config.getSection('ai'), enabled: false })

    await h.server.services.manual.parse('BV1GJ411x7h7', { want: 'summary' })
    await h.server.services.queue.drain(300)

    const job = h.deps.repos.jobs.getByBvid('BV1GJ411x7h7')
    assert.equal(job?.status, 'pending')
    await h.close()
  })

  it('转写能升级成总结：复用已有产物，不重新取字幕', async () => {
    const h = await rig()
    h.deps.config.setSection('ai', { ...h.deps.config.getSection('ai'), enabled: false })
    await h.server.services.manual.parse('BV1GJ411x7h7', { want: 'transcript' })
    await h.server.services.queue.drain(5_000)
    const viewsBefore = h.fetch.countOf('/x/web-interface/view')

    // 打开 AI 后要求总结：任务变回 pending 且目标是 summary
    const upgraded = await h.server.services.manual.parse('BV1GJ411x7h7', { want: 'summary' })
    assert.equal(upgraded.ok, true)
    const job = h.deps.repos.jobs.getByBvid('BV1GJ411x7h7')
    assert.equal(job?.want, 'summary')
    // 从 chunk 起跑的口子已经打开，历史产物留着
    assert.notEqual(h.deps.repos.artifacts.get('BV1GJ411x7h7', 'transcript'), null)
    assert.equal(h.fetch.countOf('/x/web-interface/view'), viewsBefore)
    await h.close()
  })
})
