import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FakeAsr, FakeAudioDownloader } from './fakes/asr.ts'
import type { FakeFetch } from './fakes/bili-fetch.ts'
import type { Harness, HarnessOptions } from './support/harness.ts'
import { avItem, bili, DEFAULT_SUB, llmOk, player, rig, ZH_TRACK } from './support/queue-rig.ts'

/**
 * 四级降级链走一遍。字幕、音频、转写都是假件，队列、状态机、落库落盘是真的。
 */

/** 跑一轮轮询 + 队列。 */
async function run(fetch: FakeFetch, extra: Partial<HarnessOptions> = {}): Promise<{ h: Harness }> {
  const { h } = await rig(fetch, extra)
  await h.server.services.poll.pollOnce()
  await h.server.services.queue.drain()
  return { h }
}

describe('降级链', () => {
  it('关闭官方字幕后即使有字幕也直接走 ASR', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const audio = new FakeAudioDownloader()
    const asr = new FakeAsr()
    const { h } = await rig(fetch, { audio, asr })
    h.core.config.setSection('asr', {
      ...h.core.config.getSection('asr'),
      useOfficialSubtitles: false,
    })

    await h.server.services.poll.pollOnce()
    await h.server.services.queue.drain()

    assert.equal(fetch.countOf('player/wbi/v2'), 0)
    assert.equal(fetch.countOf('sub.test/zh.json'), 0)
    assert.equal(asr.calls, 1)
    assert.deepEqual(audio.downloaded, ['BV1x'])
    assert.equal(h.core.repos.summaries.get('BV1x')?.transcriptSource, 'asr')
    await h.close()
  })

  it('字幕缺失 + 转写成功 → asr 级，音频跑完就删', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([]))
    const audio = new FakeAudioDownloader()
    const asr = new FakeAsr()
    const { h } = await run(fetch, { audio, asr })

    assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.status, 'done')
    const s = h.core.repos.summaries.get('BV1x')
    assert.equal(s?.degradePath, 'asr')
    assert.equal(s?.transcriptSource, 'asr')
    assert.equal(s?.confidence, 'high')
    // 模型回的正文要原样落库，也要进落盘的那份 Markdown。
    assert.match(s?.article ?? '', /Overview/)
    assert.match(s?.article ?? '', /第一步：先量再改/)
    assert.match(s?.fullMd ?? '', /## Overview/)
    assert.deepEqual(audio.downloaded, ['BV1x'])
    assert.deepEqual(audio.cleaned, ['/tmp/fake/BV1x.m4a'])
    // 正文要说清它是怎么走到这一级的。
    assert.match(s?.fullMd ?? '', /官方字幕：/)

    await h.close()
  })

  it('字幕缺失 + 转写失败 → 简介兜底，低置信度，音频保留待重试', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([]))
    const audio = new FakeAudioDownloader()
    const asr = new FakeAsr()
    asr.fails = true
    const { h } = await run(fetch, { audio, asr })

    const s = h.core.repos.summaries.get('BV1x')
    assert.equal(s?.degradePath, 'meta-only')
    assert.equal(s?.transcriptSource, 'none')
    assert.equal(s?.confidence, 'low')
    // 没有时间轴就不给章节。
    assert.match(s?.article ?? '', /讲清了一件事/)
    assert.match(s?.fullMd ?? '', /未获取到语音内容/)
    assert.match(s?.fullMd ?? '', /语音转写：/)
    assert.deepEqual(audio.cleaned, [])

    await h.close()
  })

  it('下载失败 → 同样落到简介兜底，转写一次都没调', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([]))
    const audio = new FakeAudioDownloader()
    audio.fails = true
    const asr = new FakeAsr()
    const { h } = await run(fetch, { audio, asr })

    assert.equal(h.core.repos.summaries.get('BV1x')?.degradePath, 'meta-only')
    assert.equal(asr.calls, 0)
    assert.match(h.core.repos.summaries.get('BV1x')?.fullMd ?? '', /下载音频失败/)

    await h.close()
  })

  it('没接转写适配器时直接退到简介兜底，任务不算失败', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([]))
    const { h } = await run(fetch)

    assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.status, 'done')
    assert.equal(h.core.repos.summaries.get('BV1x')?.degradePath, 'meta-only')

    await h.close()
  })

  it('超阈值的转写走分段汇总：调用次数等于段数加一次汇总', async () => {
    const cues = Array.from({ length: 60 }, (_, i) => ({
      from: i * 5,
      to: i * 5 + 4,
      text: `这是第 ${i} 句，说的是一段足够长的中文内容，用来把 token 数顶上去。`,
    }))
    const fetch = bili(
      [llmOk],
      cues.map((c) => ({ from: c.from, to: c.to, content: c.text })),
    )
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    const chunkCfg = { thresholdTokens: 1000, sizeTokens: 500, overlapTokens: 0 }
    h.core.config.setSection('ai', { ...h.core.config.getSection('ai'), chunk: chunkCfg })

    await h.server.services.poll.pollOnce()
    await h.server.services.queue.drain()

    // 这 60 条在 500 token 一段下切成 4 段，所以是 4 次分段 + 1 次汇总。
    assert.equal(fetch.countOf('/chat/completions'), 5)

    const s = h.core.repos.summaries.get('BV1x')
    assert.equal(s?.degradePath, 'subtitle')
    // 每次调用都记了账，页面上的用量是从这里数出来的。
    const usage = h.core.repos.llmCalls.usageSince(0)
    assert.equal(usage.calls, 5)
    assert.equal(usage.inTokens, 120 * 5)

    await h.close()
  })

  it('一条视频在等转写时，有字幕的那条照样能跑完', async () => {
    // 转写卡住不放，模拟一小时的本机 whisper。
    let release = (): void => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const asr = new FakeAsr()
    asr.transcribe = async () => {
      await held
      return asr.cues
    }

    const fetch = bili([llmOk], DEFAULT_SUB, [avItem('BV1x', '901'), avItem('BV1y', '902')])
    // BV1x 没字幕（去转写），BV1y 有字幕。
    fetch.on('player/wbi/v2', (req) =>
      player(req.query.get('bvid') === 'BV1x' ? [] : [ZH_TRACK]),
    )
    const { h } = await rig(fetch, { audio: new FakeAudioDownloader(), asr })

    await h.server.services.poll.pollOnce()
    for (let i = 0; i < 200 && h.core.repos.jobs.getByBvid('BV1y')?.status !== 'done'; i += 1) {
      await new Promise((r) => setTimeout(r, 0))
    }
    assert.equal(h.core.repos.jobs.getByBvid('BV1y')?.status, 'done')
    assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.status, 'running')

    release()
    await h.server.services.queue.drain()
    assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.status, 'done')
    await h.close()
  })

  it('正文里的时间戳被链到原视频的那一秒', async () => {
    const fetch = bili([llmOk])
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await run(fetch)

    assert.match(h.core.repos.summaries.get('BV1x')?.fullMd ?? '', /\?t=83/)
    await h.close()
  })
})
