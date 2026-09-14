import { z } from 'zod'

import { fail, ok, type Result } from '#shared/contract/failure.ts'
import type { DynamicType } from '#shared/contract/update.ts'
import type { DynamicKind } from '#shared/contract/config.ts'
import { shapeFailure } from '../../domain/bili-error.ts'
import type { BiliReader, FeedPage, ParsedDynamic } from '../../types/bili.ts'
import type { Logger } from '../../types/platform.ts'
import type { BiliHttp } from './http-client.ts'

const FEED_URL = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all'
const UPDATE_URL = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all/update'
const SPACE_URL = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space'
/** 聚合流和空间流的条目形状一样，所以两处的 features 也必须一样。 */
const FEATURES =
  'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,decorationCard,onlyfansAssetsV2,ugcDelete'

/** 可展示和过滤的基础类型；抽奖、充电专属在此基础上追加类别标记。 */
const TYPES: Record<string, DynamicType> = {
  DYNAMIC_TYPE_AV: 'AV',
  DYNAMIC_TYPE_DRAW: 'DRAW',
  DYNAMIC_TYPE_WORD: 'WORD',
  DYNAMIC_TYPE_FORWARD: 'FORWARD',
  DYNAMIC_TYPE_ARTICLE: 'ARTICLE',
  DYNAMIC_TYPE_LIVE_RCMD: 'LIVE',
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
        summary: z
          .object({
            text: z.string().default(''),
            rich_text_nodes: z.array(z.object({ type: z.string().default('') })).default([]),
          })
          .nullish(),
        pics: z.array(z.object({ url: z.string().default('') })).default([]),
        jump_url: z.string().default(''),
      })
      .nullish(),
    live_rcmd: z
      .object({
        content: z.string().default(''),
      })
      .nullish(),
    blocked: z
      .object({
        blocked_type: z.number().int().default(0),
        title: z.string().default(''),
        hint_message: z.string().default(''),
      })
      .nullish(),
    upower_common: z.unknown().nullish(),
  })

const RichTextSchema = z.object({
  text: z.string().default(''),
  type: z.string().default(''),
})

const DynModuleSchema = z.object({
  desc: z
    .object({
      text: z.string().default(''),
      rich_text_nodes: z.array(RichTextSchema).default([]),
    })
    .nullish(),
  major: MajorSchema.nullish(),
  additional: z
    .object({
      type: z.string().default(''),
      reserve: z.unknown().nullish(),
      upower_lottery: z.unknown().nullish(),
    })
    .passthrough()
    .nullish(),
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
    pics: [
      ...(major.draw?.items ?? []).map((i) => i.src),
      ...(major.opus?.pics ?? []).map((p) => p.url),
      ...(major.article?.covers ?? []),
    ].filter((u) => u !== ''),
    bvid: nz(major.archive?.bvid),
  }
}

const BASE_KIND: Record<DynamicType, DynamicKind> = {
  AV: 'video',
  DRAW: 'draw',
  WORD: 'word',
  FORWARD: 'forward',
  ARTICLE: 'article',
  LIVE: 'live',
}

function classifyKinds(
  type: DynamicType,
  self: z.infer<typeof DynModuleSchema>,
  orig: z.infer<typeof DynModuleSchema> | null | undefined,
): DynamicKind[] {
  const kinds: DynamicKind[] = [BASE_KIND[type]]
  const layers = [self, orig].filter((layer): layer is z.infer<typeof DynModuleSchema> => layer != null)
  const lottery = layers.some((layer) => {
    const additional = layer.additional
    return (
      layer.desc?.rich_text_nodes.some((node) => node.type === 'RICH_TEXT_NODE_TYPE_LOTTERY') === true ||
      layer.major?.opus?.summary?.rich_text_nodes.some(
        (node) => node.type === 'RICH_TEXT_NODE_TYPE_LOTTERY',
      ) === true ||
      additional?.upower_lottery != null ||
      /LOTTERY/.test(additional?.type ?? '')
    )
  })
  const charge = layers.some(
    (layer) =>
      layer.major?.blocked?.blocked_type === 3 ||
      layer.major?.upower_common != null ||
      layer.additional?.upower_lottery != null ||
      /UPOWER/.test(layer.additional?.type ?? ''),
  )
  if (lottery) kinds.push('lottery')
  if (charge) kinds.push('charge')
  return kinds
}

function liveContent(dyn: z.infer<typeof DynModuleSchema>): { title: string | null; text: string | null } {
  const content = dyn.major?.live_rcmd?.content
  if (content == null || content === '') return { title: null, text: null }
  try {
    const parsed = JSON.parse(content) as { live_play_info?: { title?: unknown; parent_area_name?: unknown } }
    const info = parsed.live_play_info
    return {
      title: typeof info?.title === 'string' ? nz(info.title) : null,
      text: typeof info?.parent_area_name === 'string' ? nz(info.parent_area_name) : null,
    }
  } catch {
    return { title: null, text: null }
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
      features: FEATURES,
    }
    if (opts.offset != null && opts.offset !== '') params['offset'] = opts.offset

    const res = await this.http.get<unknown>(FEED_URL, params, {
      referer: 'https://t.bilibili.com/',
    })
    return this.page('feed/all', res)
  }

  /** 空间流。不签 WBI —— 这个接口只要登录态，混淆表没配也能用。 */
  async fetchSpace(opts: { uid: string; offset?: string | null }): Promise<Result<FeedPage>> {
    const params: Record<string, string | number> = {
      host_mid: opts.uid,
      platform: 'web',
      timezone_offset: -480,
      features: FEATURES,
    }
    if (opts.offset != null && opts.offset !== '') params['offset'] = opts.offset

    const res = await this.http.get<unknown>(SPACE_URL, params, {
      referer: `https://space.bilibili.com/${opts.uid}/dynamic`,
    })
    return this.page('feed/space', res)
  }

  /** 两条流的 payload 形状一样，解析也就只写一遍。 */
  private page(api: string, res: Result<unknown>): Result<FeedPage> {
    if (!res.ok) return res

    const parsed = FeedSchema.safeParse(res.value)
    if (!parsed.success) return fail(shapeFailure(api, res.value))

    const items: ParsedDynamic[] = []
    let unparsed = 0
    let unsupported = 0
    for (const raw of parsed.data.items) {
      const one = this.parseItem(raw)
      if (one === 'unparsed') unparsed += 1
      else if (one === 'unsupported') unsupported += 1
      else items.push(one)
    }
    if (unparsed > 0) this.logger.warn({ unparsed }, '动态 payload 解析失败')
    if (unsupported > 0) this.logger.debug({ unsupported }, '跳过不支持的动态类型')

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
    const live = liveContent(item.modules.module_dynamic)
    // 转发的正文只是转发语，内容在 orig 里。取过来，更新流才有封面标题，过滤规则才看得见被转的视频标题。
    const from = type === 'FORWARD' ? contentOf(item.orig?.modules?.module_dynamic) : null
    const kinds = classifyKinds(type, item.modules.module_dynamic, item.orig?.modules?.module_dynamic)

    // 有意不继承 orig 的 bvid：转发别人的视频不该触发我们的字幕总结链路。
    const bvid = self.bvid

    return {
      dynId: item.id_str,
      uid: String(author.mid),
      uname: author.name,
      face: nz(author.face),
      type,
      kinds,
      pubTs: author.pub_ts,
      title: self.title ?? from?.title ?? live.title,
      text: self.text ?? live.text,
      // 视频简介 / 专栏摘要。过滤规则的匹配范围里有它，所以要一路带下去。
      desc: self.desc ?? from?.desc ?? from?.text ?? null,
      cover: self.cover ?? from?.cover ?? null,
      pics: self.pics.length > 0 ? self.pics : (from?.pics ?? []),
      bvid,
      url: bvid != null ? `https://www.bilibili.com/video/${bvid}` : `https://t.bilibili.com/${item.id_str}`,
      raw,
    }
  }
}
