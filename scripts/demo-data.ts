import type { FakeFetch, FakeResponse } from '../test/fakes/bili-fetch.ts'

/** demo 用的假 B 站数据。改这里就能造出你想复现的分支。 */

export const DEMO_UP = { uid: '2233', name: '演示 UP 主', face: null }

const IMG = 'https://i0.hdslb.com/bfs/wbi/aaaaaaaabbbbbbbbccccccccdddddddd.png'
const SUB = 'https://i0.hdslb.com/bfs/wbi/11111111222222223333333344444444.png'

interface DemoVideo {
  bvid: string
  cid: number
  title: string
  desc: string
  /** 'human' 人工字幕 / 'ai' 只有 AI 字幕 / 'none' 没字幕，退到语音转写。 */
  subtitle: 'human' | 'ai' | 'none'
  cues: Array<[number, string]>
  /** 只出现在空间流里，不在聚合流里 —— 用来演「地板之前的历史，手动点解析」。 */
  historyOnly?: boolean
}

const VIDEOS: DemoVideo[] = [
  {
    bvid: 'BV1Demo001',
    cid: 1001,
    title: '用 Node 24 原生跑 TypeScript：不装编译器的三个前提',
    desc: '讲清 strip-only 能做什么、不能做什么。',
    subtitle: 'human',
    cues: [
      [0, '这期讲怎么让 Node 24 直接跑 TypeScript 源码，不装 ts-node 也不先编译。'],
      [12, '先说结论：能跑，但有三个前提，踩不过去的话报错信息会很难懂。'],
      [31, '第一个前提是只做类型剥离，所以 enum、namespace、构造函数参数属性统统不能用。'],
      [58, '第二个前提是模块解析，package.json 要写 type module，相对导入要带 .ts 后缀。'],
      [92, '第三个前提是 tsconfig 里的 rewriteRelativeImportExtensions，编译产物才不会带错后缀。'],
      [131, '接下来演示一个真实项目的目录结构，前后端共用一份 contract。'],
      [178, '后端只出 d.ts，运行时直接读源码，改完保存就生效，省掉一次构建。'],
      [220, '测试用 node:test，配合内置 sqlite，整套依赖比想象的少。'],
      [266, '最后提醒一句：strip-only 的报错行号是准的，别怀疑，先看有没有用到禁用语法。'],
      [297, '这期就到这里，下期讲怎么把它塞进一个 80MB 的容器镜像。'],
    ],
  },
  {
    bvid: 'BV1Demo002',
    cid: 1002,
    title: 'SQLite 做单机常驻服务的库：什么时候会咬人',
    desc: 'WAL、并发写、备份三件事。',
    subtitle: 'ai',
    cues: [
      [0, '很多人问单机服务用 SQLite 靠不靠谱，我的答案是靠谱，但有三处会咬人。'],
      [25, '第一是并发写，SQLite 是单写多读，写事务要短，别在事务里等网络。'],
      [70, '第二是 WAL 模式，没开的话读写互相阻塞，开了要记得三个文件一起备份。'],
      [118, '第三是备份，直接拷贝 db 文件在写入中途会拿到坏副本，用 VACUUM INTO。'],
      [165, '演示一下这三件事分别怎么触发，以及日志里长什么样。'],
      [230, '结论是十万行级别的数据完全不用上 Postgres，省下来的运维时间更值钱。'],
    ],
  },
  {
    bvid: 'BV1Demo003',
    cid: 1003,
    title: '这个视频没有字幕（用来看语音转写那条降级路）',
    desc: '字幕清单为空，于是下载音频、本地转写，处理路径会显示「语音转写」。',
    subtitle: 'none',
    cues: [
      [0, '这条视频没有字幕，所以你看到的这些句子是转写出来的。'],
      [22, '流程是先下音频，再交给本地模型，出来的东西和字幕一个形状。'],
      [64, '转写也失败的话，就退到只看标题和简介的推测，会标成低置信度。'],
      [108, '再往下全挂了，也还会留一条只有标题、封面和链接的最小记录。'],
    ],
  },
  {
    bvid: 'BV1Demo004',
    cid: 1004,
    title: '这是启动之前的老投稿（只在空间流里，要自己点解析）',
    desc: '定时抓取只要启动之后新发的，所以它没入库；在阅读页选这个 UP 就能翻到它。',
    subtitle: 'human',
    historyOnly: true,
    cues: [
      [0, '这条是老投稿，轮询不会抓它，因为它发布在服务启动之前。'],
      [30, '在阅读页点这个 UP 的头像，左栏就是现拉的空间流，翻到它点「加入解析队列」。'],
      [75, '解析完右栏会多出一个「解析信息」的标签页，和自动抓到的那几条一模一样。'],
    ],
  },
]

/** 没字幕那条走转写：demo 里由假转写吐这些句子，省掉 yt-dlp 与本地模型。 */
export function demoAsrCues(bvid: string): Array<{ from: number; to: number; text: string }> {
  const v = byBvid.get(bvid)
  if (v === undefined) return []
  return v.cues.map(([from, text], i) => ({ from, to: v.cues[i + 1]?.[0] ?? from + 5, text }))
}

export const demoVideos = (): DemoVideo[] => VIDEOS.filter((v) => v.historyOnly !== true)

const byBvid = new Map(VIDEOS.map((v) => [v.bvid, v]))

/** 轮询有抓取地板：要被抓到就得发布在启动之后，老投稿则相反。 */
const pubTs = (v: DemoVideo, i: number): number => {
  const now = Math.trunc(Date.now() / 1000)
  return v.historyOnly === true ? now - 86_400 : now + (i + 1) * 60
}

const feedItem = (v: DemoVideo, i: number) => ({
  id_str: `90${i}`,
  type: 'DYNAMIC_TYPE_AV',
  modules: {
    module_author: {
      mid: Number(DEMO_UP.uid),
      name: DEMO_UP.name,
      face: 'https://i0.hdslb.com/demo.jpg',
      pub_ts: String(pubTs(v, i)),
    },
    module_dynamic: {
      desc: null,
      major: {
        type: 'MAJOR_TYPE_ARCHIVE',
        archive: { bvid: v.bvid, title: v.title, desc: v.desc, cover: 'https://i0.hdslb.com/cover.jpg' },
        draw: null,
        article: null,
        opus: null,
        live_rcmd: null,
      },
    },
  },
})

const tracksFor = (v: DemoVideo): unknown[] => {
  if (v.subtitle === 'none') return []
  const ai = v.subtitle === 'ai'
  return [
    {
      lan: 'zh-CN',
      lan_doc: ai ? '中文（自动生成）' : '中文（人工）',
      ai_type: ai ? 1 : 0,
      subtitle_url: `//sub.demo/${v.bvid}.json`,
    },
  ]
}

/** 取第一个小句，别在词中间切断。 */
const clause = (text: string): string => text.split(/[。，、：]/)[0]!.slice(0, 18)

/** 编排好的假回答：Markdown 正文，小节标题带时间戳，看着像真的阅读版本。 */
function fakeCompletion(body: string | null): FakeResponse {
  const prompt = body ?? ''
  const video = VIDEOS.find((v) => prompt.includes(v.title)) ?? VIDEOS[0]!
  const sections = video.cues.filter((_, i) => i % 3 === 0)
  const lines = ['## Overview', '', `${video.desc}${video.cues[0]?.[1] ?? ''}`, '']

  for (const [sec, text] of sections) {
    lines.push(`## [${hms(sec)}] ${clause(text)}`, '', text, '')
    const details = video.cues.filter(([at]) => at > sec).slice(0, 2)
    for (const [, d] of details) lines.push(`- ${d}`)
    if (details.length > 0) lines.push('')
  }

  lines.push('## 框架 & 心智模型', '', `${clause(video.cues.at(-1)?.[1] ?? '')}：`, '')
  for (const [, text] of video.cues.slice(-2)) lines.push(`- ${text}`)

  return {
    raw: {
      choices: [{ message: { content: lines.join('\n') } }],
      usage: { prompt_tokens: 800 + video.cues.length * 20, completion_tokens: 1200 },
    },
  }
}

/** 秒 → mm:ss。demo 自己拼假回答里的时间戳，不想为一个格式化去 import 服务端。 */
function hms(sec: number): string {
  const mm = String(Math.trunc(sec / 60)).padStart(2, '0')
  return `${mm}:${String(sec % 60).padStart(2, '0')}`
}

/** 把 demo 需要的每一跳都打上桩。顺序有意义：先具体后通用。 */
export function demoBili(fake: FakeFetch): FakeFetch {
  return fake
    .on('feed/all/update', { data: { update_num: VIDEOS.length } })
    .on('feed/all', {
      data: {
        items: VIDEOS.filter((v) => v.historyOnly !== true).map(feedItem),
        has_more: false,
        offset: '',
        update_baseline: `demo-${Date.now()}`,
      },
    })
    // 空间流多一条老投稿：阅读页里它是「没入库、可以手动解析」的那种。
    .on('feed/space', {
      data: {
        items: VIDEOS.map(feedItem),
        has_more: false,
        offset: '',
        update_baseline: `demo-${Date.now()}`,
      },
    })
    .on('web-interface/nav', {
      data: { wbi_img: { img_url: IMG, sub_url: SUB }, isLogin: true, mid: 4321, uname: '演示小号' },
    })
    .on('web-interface/view', (req) => {
      const v = byBvid.get(req.query.get('bvid') ?? '')
      return v === undefined ? { code: -404, message: '啥都木有' } : { data: { cid: v.cid, pages: [{ cid: v.cid }] } }
    })
    .on('player/wbi/v2', (req) => {
      const v = byBvid.get(req.query.get('bvid') ?? '')
      return { data: { subtitle: { subtitles: v === undefined ? [] : tracksFor(v) } } }
    })
    .on('sub.demo/', (req) => {
      const bvid = req.url.split('/').pop()?.replace('.json', '') ?? ''
      const v = byBvid.get(bvid)
      const body = (v?.cues ?? []).map(([from, content], i) => ({
        from,
        to: v?.cues[i + 1]?.[0] ?? from + 5,
        content,
      }))
      return { raw: { body } }
    })
    .on('/chat/completions', (req) => fakeCompletion(req.body))
    .on('relation/stat', { data: { following: 1, follower: 0 } })
    // 装成「已登录、已关注」，省掉两条一启动就跳的 WARN。
    .on('cookie/info', { data: { refresh: false, timestamp: Date.now() } })
    .on('relation/relations', { data: { [DEMO_UP.uid]: { attribute: 2 } } })
}
