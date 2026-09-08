import type { AppEvent } from '#shared/contract/events.ts'
import { FakeFetch, type FakeResponse } from '../fakes/bili-fetch.ts'
import { createHarness, type Harness, type HarnessOptions } from './harness.ts'

/** 总结队列相关测试的公共舞台：一个订阅、一条视频动态、一份字幕、一个 LLM。 */

const IMG = 'https://i0.hdslb.com/bfs/wbi/aaaaaaaabbbbbbbbccccccccdddddddd.png'
const SUB = 'https://i0.hdslb.com/bfs/wbi/11111111222222223333333344444444.png'

export const avItem = (bvid: string, idStr: string, title = '视频标题'): unknown => ({
  id_str: idStr,
  type: 'DYNAMIC_TYPE_AV',
  modules: {
    module_author: { mid: 111, name: 'UP-111', face: 'https://f/111.jpg', pub_ts: '1700000100' },
    module_dynamic: {
      desc: null,
      // 用不上的 major 分支是显式 null，真 payload 就是这样（见 poll.test 的注释）。
      major: {
        type: 'MAJOR_TYPE_ARCHIVE',
        archive: { bvid, title, desc: '视频简介', cover: 'https://c/av.jpg' },
        draw: null,
        article: null,
        opus: null,
        live_rcmd: null,
      },
    },
  },
})

export const AV_ITEM = avItem('BV1x', '901')

export const REPLY = JSON.stringify({
  tldr: '一句话讲完这个视频',
  points: ['要点一', '要点二', '要点三'],
  overview: '第一段说清背景。\n\n第二段说清结论。',
  keyInfo: {
    terms: [{ name: 'WBI', desc: '一种查询签名' }],
    facts: ['吞吐提升 3 倍'],
    resources: [{ name: 'yt-dlp', note: '下音频' }],
  },
  chapters: [
    { startSec: 0, title: '开场', desc: null, summary: '开场交代了背景。' },
    { startSec: 83, title: '正题', desc: '细说', summary: '正题给出了做法和结论。' },
  ],
})

export const llmOk: FakeResponse = {
  raw: { choices: [{ message: { content: REPLY } }], usage: { prompt_tokens: 120, completion_tokens: 40 } },
}

/** subtitles 为空 = 这个视频没字幕。 */
export const player = (tracks: unknown[]): FakeResponse => ({ data: { subtitle: { subtitles: tracks } } })

export const ZH_TRACK = { lan: 'zh-CN', lan_doc: '中文', ai_type: 0, subtitle_url: '//sub.test/zh.json' }

export interface SubtitleLine {
  from: number
  to: number
  content: string
}

export const DEFAULT_SUB: SubtitleLine[] = [
  { from: 0, to: 4, content: '大家好' },
  { from: 83, to: 86, content: '进入正题' },
]

/**
 * llm：依次返回的 LLM 响应，用完重复最后一个。sub：字幕条。
 *
 * 两者都从参数进来而不是让调用方事后 `.on()` 覆盖 —— FakeFetch 按注册顺序匹配，
 * 后注册的规则永远命不中，那种测试会静悄悄地测了个别的东西。
 */
export function bili(
  llm: FakeResponse[] = [llmOk],
  sub: SubtitleLine[] = DEFAULT_SUB,
  items: unknown[] = [AV_ITEM],
): FakeFetch {
  return new FakeFetch()
    .on('feed/all/update', { data: { update_num: items.length } })
    .on('feed/all', { data: { items, has_more: false, offset: '', update_baseline: 'b1' } })
    .on('web-interface/nav', { data: { wbi_img: { img_url: IMG, sub_url: SUB } } })
    .on('web-interface/view', { data: { cid: 555, pages: [{ cid: 555 }] } })
    .on('sub.test/zh.json', { raw: { body: sub } })
    .onSequence('/chat/completions', llm)
}

export async function rig(
  fetch: FakeFetch,
  extra: Partial<HarnessOptions> = {},
): Promise<{ h: Harness; events: AppEvent[] }> {
  const h = await createHarness({
    fetch,
    cookies: ['SESSDATA=fake; Path=/; Domain=.bilibili.com'],
    ...extra,
  })
  h.core.repos.subscriptions.upsert({
    uid: '111',
    name: 'UP-111',
    face: null,
    enableDynamic: true,
    enableVideo: true,
    enableAi: true,
  })
  h.core.config.setSection('bili', {
    ...h.core.config.getSection('bili'),
    wbiMixinTable: Array.from({ length: 64 }, (_, i) => i),
  })
  h.core.config.setSection('ai', {
    ...h.core.config.getSection('ai'),
    enabled: true,
    baseURL: 'https://llm.test/v1',
    model: 'm1',
  })
  const events: AppEvent[] = []
  h.events.on((e) => events.push(e))
  h.server.services.queue.start()
  return { h, events }
}
