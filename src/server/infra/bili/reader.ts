import { z } from 'zod'

import { fail, ok, type Result } from '#shared/contract/failure.ts'
import type { DynamicType } from '#shared/contract/update.ts'
import { shapeFailure } from '../../domain/bili-error.ts'
import type { BiliReader, FeedPage, ParsedDynamic } from '../../ports/bili.ts'
import type { Logger } from '../../ports/logger.ts'
import type { BiliHttp } from './http-client.ts'

const FEED_URL = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all'
const UPDATE_URL = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all/update'

/** 只认这五类，别的（直播、番剧推送等）直接跳过。 */
const TYPES: Record<string, DynamicType> = {
  DYNAMIC_TYPE_AV: 'AV',
  DYNAMIC_TYPE_DRAW: 'DRAW',
  DYNAMIC_TYPE_WORD: 'WORD',
  DYNAMIC_TYPE_FORWARD: 'FORWARD',
  DYNAMIC_TYPE_ARTICLE: 'ARTICLE',
}

const AuthorSchema = z.object({
  mid: z.union([z.string(), z.number()]),
  name: z.string().default(''),
  face: z.string().default(''),
  // 实测回的是字符串 "1788835993"，不是数字。
  pub_ts: z.coerce.number().int().default(0),
})

/**
 * major 的五种形状。用 nullish 而不是 optional：真实 payload 把用不上的分支
 * 全写成显式 null（`archive: null, opus: null, …`），optional 只放过 undefined。
 */
const MajorSchema = z
  .object({
    type: z.string().nullish(),
    archive: z
      .object({
        bvid: z.string().default(''),
        title: z.string().default(''),
        desc: z.string().default(''),
        cover: z.string().default(''),
        jump_url: z.string().default(''),
      })
      .nullish(),
    draw: z
      .object({ items: z.array(z.object({ src: z.string().default('') })).default([]) })
      .nullish(),
    article: z
      .object({
        title: z.string().default(''),
        desc: z.string().default(''),
        covers: z.array(z.string()).default([]),
        jump_url: z.string().default(''),
      })
      .nullish(),
    opus: z
      .object({
        title: z.string().nullish(),
        summary: z.object({ text: z.string().default('') }).nullish(),
        pics: z.array(z.object({ url: z.string().default('') })).default([]),
        jump_url: z.string().default(''),
      })
      .nullish(),
  })

const DynModuleSchema = z.object({
  desc: z.object({ text: z.string().default('') }).nullish(),
  major: MajorSchema.nullish(),
})

const ItemSchema = z.object({
  id_str: z.string(),
  type: z.string(),
  modules: z.object({
    module_author: AuthorSchema,
    module_dynamic: DynModuleSchema.default({}),
  }),
  /** 转发源。原动态被删时 modules 整段缺失，所以每层都得可选。 */
  orig: z
    .object({
      modules: z
        .object({
          module_author: z.object({ name: z.string().default('') }).nullish(),
          module_dynamic: DynModuleSchema.nullish(),
        })
        .nullish(),
    })
    .nullish(),
})

const FeedSchema = z.object({
  items: z.array(z.unknown()).default([]),
  has_more: z.boolean().default(false),
  offset: z.string().default(''),
  update_baseline: z.string().default(''),
})

const UpdateNumSchema = z.object({ update_num: z.number().int().default(0) })

const nz = (s: string | null | undefined): string | null => (s == null || s === '' ? null : s)

/** 一层动态里的可读内容。同一套逻辑要对外层和转发源各跑一遍。 */
function contentOf(dyn: z.infer<typeof DynModuleSchema> | null | undefined) {
  const major = dyn?.major ?? {}
  return {
    text: nz(dyn?.desc?.text) ?? nz(major.opus?.summary?.text),
    title: nz(major.archive?.title) ?? nz(major.article?.title) ?? nz(major.opus?.title),
    desc: nz(major.archive?.desc) ?? nz(major.article?.desc),
    cover:
      nz(major.archive?.cover) ??
      nz(major.article?.covers[0]) ??
      nz(major.draw?.items[0]?.src) ??
      nz(major.opus?.pics[0]?.url),
    bvid: nz(major.archive?.bvid),
  }
}

export class BiliReaderClient implements BiliReader {
  private readonly http: BiliHttp
  private readonly logger: Logger

  constructor(http: BiliHttp, logger: Logger) {
    this.http = http
    this.logger = logger.child({ mod: 'bili-reader' })
  }

  async fetchFeed(opts: { offset?: string | null } = {}): Promise<Result<FeedPage>> {
    const params: Record<string, string | number> = {
      type: 'all',
      platform: 'web',
      timezone_offset: -480,
      // 不带 itemOpusStyle 的话，图文的正文既不在 desc 也不在 major 里，等于抓回来一条没内容的动态。
      features: 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,decorationCard,onlyfansAssetsV2,ugcDelete',
    }
    if (opts.offset != null && opts.offset !== '') params['offset'] = opts.offset

    const res = await this.http.get<unknown>(FEED_URL, params, {
      referer: 'https://t.bilibili.com/',
    })
    if (!res.ok) return res

    const parsed = FeedSchema.safeParse(res.value)
    if (!parsed.success) return fail(shapeFailure('feed/all', res.value))

    const items: ParsedDynamic[] = []
    let unparsed = 0
    let unsupported = 0
    for (const raw of parsed.data.items) {
      const one = this.parseItem(raw)
      if (one === 'unparsed') unparsed += 1
      else if (one === 'unsupported') unsupported += 1
      else items.push(one)
    }
    if (unparsed > 0) this.logger.warn({ unparsed }, '有动态的 payload 形状不认识，这一页没吃全')
    if (unsupported > 0) this.logger.debug({ unsupported }, '跳过了不关心的动态类型')

    return ok({
      items,
      unparsed,
      hasMore: parsed.data.has_more,
      offset: parsed.data.offset === '' ? null : parsed.data.offset,
      baseline: parsed.data.update_baseline === '' ? null : parsed.data.update_baseline,
    })
  }

  /** 心跳：只问「比 baseline 新的有几条」，比拉全量便宜得多。 */
  async countSince(baseline: string): Promise<Result<number>> {
    const res = await this.http.get<unknown>(
      UPDATE_URL,
      { type: 'all', update_baseline: baseline },
      { referer: 'https://t.bilibili.com/' },
    )
    if (!res.ok) return res
    const parsed = UpdateNumSchema.safeParse(res.value)
    return parsed.success ? ok(parsed.data.update_num) : fail(shapeFailure('feed/all/update', res.value))
  }

  /**
   * 一条怪 payload 不该让整页作废，所以认不出就跳过。但两种「认不出」要分开：
   * unsupported 是我们主动不要（直播、番剧推送），unparsed 是形状变了、我们看漏了内容。
   */
  private parseItem(raw: unknown): ParsedDynamic | 'unparsed' | 'unsupported' {
    const parsed = ItemSchema.safeParse(raw)
    if (!parsed.success) {
      // 带上出错字段：payload 形状变了的时候，只报个数根本查不出是哪一层变了。
      this.logger.warn(
        { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
        '动态解析失败',
      )
      return 'unparsed'
    }

    const item = parsed.data
    const type = TYPES[item.type]
    if (type === undefined) return 'unsupported'

    const author = item.modules.module_author
    const self = contentOf(item.modules.module_dynamic)
    // 转发的正文只是转发语，内容在 orig 里。取过来，更新流才有封面标题，过滤规则才看得见被转的视频标题。
    const from = type === 'FORWARD' ? contentOf(item.orig?.modules?.module_dynamic) : null

    // 有意不继承 orig 的 bvid：转发别人的视频不该触发我们的字幕总结链路。
    const bvid = self.bvid

    return {
      dynId: item.id_str,
      uid: String(author.mid),
      uname: author.name,
      face: nz(author.face),
      type,
      pubTs: author.pub_ts,
      title: self.title ?? from?.title ?? null,
      text: self.text,
      // 视频简介 / 专栏摘要。过滤规则的匹配范围里有它，所以要一路带下去。
      desc: self.desc ?? from?.desc ?? from?.text ?? null,
      cover: self.cover ?? from?.cover ?? null,
      bvid,
      url: bvid != null ? `https://www.bilibili.com/video/${bvid}` : `https://t.bilibili.com/${item.id_str}`,
      raw,
    }
  }
}
