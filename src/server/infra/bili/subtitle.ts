import { z } from 'zod'

import { fail, ok, type Result } from '#shared/contract/failure.ts'
import type { Cue } from '#shared/contract/summary.ts'
import { fatalFailure, shapeFailure } from '../../domain/bili-error.ts'
import type { SubtitleFetcher } from '../../types/bili.ts'
import type { Logger } from '../../types/platform.ts'
import type { BiliHttp } from './http-client.ts'

/**
 * 官方/AI 字幕。三跳：`view` 拿 cid → `player/wbi/v2` 拿字幕清单 → 取字幕 JSON。
 *
 * 免登录时 `player/v2` 的 subtitles 恒为空数组（spec 已实测），所以「拿不到字幕」和
 * 「没登录」在这一层分不开 —— 登录态由上游保证，这里只负责如实返回 null。
 *
 * 字幕清单与字幕 JSON 的字段形状属于未验证项（参考实现没有这条链），因此 schema
 * 一律给默认值，缺字段当空而不是整条炸掉。
 */

const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view'
const PLAYER_URL = 'https://api.bilibili.com/x/player/wbi/v2'

const ViewSchema = z.object({
  aid: z.coerce.number().int().optional(),
  cid: z.coerce.number().int().optional(),
  pages: z.array(z.object({ cid: z.coerce.number().int(), part: z.string().default('') })).default([]),
})

const TrackSchema = z.object({
  lan: z.string().default(''),
  lan_doc: z.string().default(''),
  subtitle_url: z.string().default(''),
  /** 0 = 人工字幕；非 0 = AI 生成。两种都要，只是人工的优先。 */
  ai_type: z.coerce.number().default(0),
})
type Track = z.infer<typeof TrackSchema>

const PlayerSchema = z.object({
  subtitle: z
    .object({ subtitles: z.array(TrackSchema).default([]) })
    .nullish(),
})

const BodySchema = z.object({
  body: z
    .array(
      z.object({
        from: z.coerce.number().default(0),
        to: z.coerce.number().default(0),
        content: z.string().default(''),
      }),
    )
    .default([]),
})

export class BiliSubtitleClient implements SubtitleFetcher {
  private readonly http: BiliHttp
  private readonly logger: Logger

  constructor(http: BiliHttp, logger: Logger) {
    this.http = http
    this.logger = logger.child({ mod: 'subtitle' })
  }

  async parts(bvid: string): Promise<Result<string[]>> {
    const view = await this.http.get<unknown>(VIEW_URL, { bvid })
    if (!view.ok) return fail(view.failure)
    const parsed = ViewSchema.safeParse(view.value)
    if (!parsed.success) return fail(shapeFailure('view', view.value))
    return ok(parsed.data.pages.map((p) => p.part).filter((t) => t.trim() !== ''))
  }

  /** null = 这个视频确实没有字幕（含 AI 字幕）。失败是值，调用方按 kind 决定重试。 */
  async fetch(bvid: string): Promise<Result<Cue[] | null>> {
    const view = await this.http.get<unknown>(VIEW_URL, { bvid })
    if (!view.ok) return fail(view.failure)
    const parsedView = ViewSchema.safeParse(view.value)
    if (!parsedView.success) return fail(shapeFailure('view', view.value))
    const cid = parsedView.data.cid ?? parsedView.data.pages[0]?.cid
    if (cid === undefined) return fail(fatalFailure(`${bvid} 没有 cid，取不到字幕`))

    const referer = `https://www.bilibili.com/video/${bvid}`
    const player = await this.http.get<unknown>(PLAYER_URL, { bvid, cid }, { wbi: true, referer })
    if (!player.ok) return fail(player.failure)
    const parsedPlayer = PlayerSchema.safeParse(player.value)
    if (!parsedPlayer.success) return fail(shapeFailure('player/v2', player.value))

    const tracks = parsedPlayer.data.subtitle?.subtitles ?? []
    const picked = pickTrack(tracks)
    if (picked === null) {
      this.logger.info({ bvid, tracks: tracks.length }, '无可用字幕')
      return ok(null)
    }

    const json = await this.http.getText(absolute(picked.subtitle_url), { referer })
    if (!json.ok) return fail(json.failure)

    let raw: unknown
    try {
      raw = JSON.parse(json.value)
    } catch {
      return fail(fatalFailure(`字幕文件不是 JSON：${json.value.slice(0, 120)}`))
    }
    const parsedBody = BodySchema.safeParse(raw)
    if (!parsedBody.success) return fail(shapeFailure('字幕文件', raw))

    const cues: Cue[] = parsedBody.data.body
      .map((c) => ({ from: c.from, to: c.to, text: c.content.trim() }))
      .filter((c) => c.text !== '')
    this.logger.info({ bvid, lan: picked.lan, cues: cues.length }, '字幕已获取')
    return ok(cues.length === 0 ? null : cues)
  }
}

/** 中文人工 > 中文 AI > 任何一条有 url 的。没有 url 的条目等于不存在。 */
function pickTrack(tracks: readonly Track[]): Track | null {
  const usable = tracks.filter((t) => t.subtitle_url.trim() !== '')
  const zh = usable.filter((t) => t.lan.startsWith('zh'))
  return zh.find((t) => t.ai_type === 0) ?? zh[0] ?? usable[0] ?? null
}

/** 字幕地址是协议相对的（`//aisubtitle.hdslb.com/...`）。 */
const absolute = (url: string): string => (url.startsWith('//') ? `https:${url}` : url)
