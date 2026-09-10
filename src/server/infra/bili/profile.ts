import { z } from 'zod'

import { fail, ok, type Result } from '#shared/contract/failure.ts'
import type { UpSearchItem } from '#shared/contract/api.ts'
import { shapeFailure } from '../../domain/bili-error.ts'
import type { BiliProfile, UpCard } from '../../types/bili.ts'
import type { BiliHttp } from './http-client.ts'

/** 名片接口。挑它而不是 `x/space/wbi/acc/info` 是因为**这个不用 WBI 签名** —— 混淆表是留空待填的配置，订阅页不应因为它没填就连昵称都查不到 */
const CARD_URL = 'https://api.bilibili.com/x/web-interface/card'
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type'
const SEARCH_LIMIT = 20

const CardSchema = z.object({
  card: z.object({
    mid: z.union([z.string(), z.number()]),
    name: z.string(),
    face: z.string().default(''),
  }),
})

const SearchSchema = z.object({
  result: z
    .array(
      z.object({
        mid: z.union([z.string(), z.number()]),
        uname: z.string(),
        upic: z.string().default(''),
        usign: z.string().default(''),
        fans: z.coerce.number().int().min(0).default(0),
      }),
    )
    .nullish(),
})

export class BiliProfileClient implements BiliProfile {
  private readonly http: BiliHttp

  constructor(http: BiliHttp) {
    this.http = http
  }

  async fetchCard(uid: string): Promise<Result<UpCard>> {
    const res = await this.http.get<unknown>(CARD_URL, { mid: uid, photo: 'false' })
    if (!res.ok) return res

    const parsed = CardSchema.safeParse(res.value)
    if (!parsed.success) return fail(shapeFailure('web-interface/card', res.value))

    const { card } = parsed.data
    return ok({
      uid: String(card.mid),
      name: card.name,

      face: card.face === '' ? null : card.face,
    })
  }

  async search(name: string): Promise<Result<UpSearchItem[]>> {
    const res = await this.http.get<unknown>(SEARCH_URL, {
      search_type: 'bili_user',
      keyword: name,
      page: 1,
      page_size: SEARCH_LIMIT,
    })
    if (!res.ok) return res

    const parsed = SearchSchema.safeParse(res.value)
    if (!parsed.success) return fail(shapeFailure('search/type', res.value))

    return ok(
      (parsed.data.result ?? []).map((item) => ({
        uid: String(item.mid),
        name: item.uname,
        face: item.upic === '' ? null : item.upic,
        signature: item.usign,
        fans: item.fans,
      })),
    )
  }
}
