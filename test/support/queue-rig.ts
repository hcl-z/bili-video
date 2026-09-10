import type { AppEvent } from '#shared/contract/events.ts'
import { FakeFetch, type FakeResponse } from '../fakes/bili-fetch.ts'
import { createHarness, type Harness, type HarnessOptions } from './harness.ts'
import { pubAt } from './time.ts'

/** 总结队列相关测试的公共舞台：一个订阅、单条视频动态、一份字幕、一个 LLM */

const IMG = 'https://i0.hdslb.com/bfs/wbi/aaaaaaaabbbbbbbbccccccccdddddddd.png'
const SUB = 'https://i0.hdslb.com/bfs/wbi/11111111222222223333333344444444.png'

export const avItem = (bvid: string, idStr: string, title = '视频标题'): unknown => ({
  id_str: idStr,
  type: 'DYNAMIC_TYPE_AV',
  modules: {
    module_author: { mid: 111, name: 'UP-111', face: 'https://f/111.jpg', pub_ts: String(pubAt(100)) },
    module_dynamic: {
      desc: null,
      // 用不上的 major 分支是显式 null，真 payload 就是这样（见 poll.test 的注释）
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

/** 模型回的是 Markdown 正文，不是 JSON */
export const REPLY = [
  '## Overview',
  '',
  '这个视频讲清了一件事，并给出了结论。',
  '',
  '## [01:23] 正题',
  '',
  '这一节把做法拆成了几步：',
  '',
  '- 第一步：先量再改',
  '- 第二步：改完再量',
].join('\n')

export const llmOk: FakeResponse = {
  raw: { choices: [{ message: { content: REPLY } }], usage: { prompt_tokens: 120, completion_tokens: 40 } },
}


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

/** llm：依次返回的 LLM 响应，用完重复最后一个。sub：字幕条。 两者都从参数进来而不是让调用方事后 `.on()` 覆盖 —— FakeFetch 按注册顺序匹配， 后注册的规则永远命不中，那种测试会静悄悄地测了个避免的数据 */
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
