import { z } from 'zod'

import { fail, ok, type Result } from '#shared/contract/failure.ts'
import type { ParsedDynamic } from '../../types/bili.ts'
import { shapeFailure } from '../../domain/bili-error.ts'
import type { BiliHttp } from './http-client.ts'

/** 按 bvid 直接取视频元信息。字幕那条链用的是同一跳，但只关心 cid —— 手动排解析需要标题、封面、简介，所以单独开一个 */

const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view'

const OwnerSchema = z.object({
  mid: z.union([z.string(), z.number()]),
  name: z.string().default(''),
  face: z.string().default(''),
})

export const ViewSchema = z.object({
  bvid: z.string().default(''),
  aid: z.coerce.number().int().optional(),
  cid: z.coerce.number().int().optional(),
  title: z.string().default(''),
  desc: z.string().default(''),
  pic: z.string().default(''),
  pubdate: z.coerce.number().int().default(0),
  owner: OwnerSchema.nullish(),
  pages: z
    .array(z.object({ cid: z.coerce.number().int(), part: z.string().default('') }))
    .default([]),
})

export type VideoView = z.infer<typeof ViewSchema>

export class BiliVideoClient {
  private readonly http: BiliHttp

  constructor(http: BiliHttp) {
    this.http = http
  }

  async view(bvid: string): Promise<Result<VideoView>> {
    const res = await this.http.get<unknown>(VIEW_URL, { bvid })
    if (!res.ok) return fail(res.failure)
    const parsed = ViewSchema.safeParse(res.value)
    if (!parsed.success) return fail(shapeFailure('view', res.value))
    if (parsed.data.title === '') return fail(shapeFailure('view', res.value))
    return ok(parsed.data)
  }

  /**
   * 合成一条动态形状的记录。手动排解析时没有真实动态 id，
   * 用 `manual-<bvid>` 当占位：它只需要稳定、可判重，不会和真实 dyn_id 撞。
   */
  async asDynamic(bvid: string): Promise<Result<ParsedDynamic>> {
    const view = await this.view(bvid)
    if (!view.ok) return fail(view.failure)

    const v = view.value
    const uid = v.owner === null || v.owner === undefined ? '' : String(v.owner.mid)
    return ok({
      dynId: `manual-${bvid}`,
      uid,
      uname: v.owner?.name ?? '',
      face: v.owner?.face === '' || v.owner === null || v.owner === undefined ? null : v.owner.face,
      type: 'AV',
      kinds: ['video'],
      pubTs: v.pubdate,
      title: v.title,
      text: v.desc,
      desc: v.desc,
      cover: v.pic === '' ? null : v.pic,
      pics: [],
      bvid,
      url: `https://www.bilibili.com/video/${bvid}`,
      raw: v,
    })
  }
}

/** bvid 会拼进 URL 和库里的唯一键，只放白名单字符。 */
export const BVID_RE = /^BV[0-9A-Za-z]{10}$/

export const isBvid = (value: string): boolean => BVID_RE.test(value)
