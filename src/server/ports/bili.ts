import type { DynamicType } from '#shared/contract/update.ts'
import type { Cue } from '#shared/contract/summary.ts'
import type { Result } from '#shared/contract/failure.ts'

/**
 * B 站 API 拆成四个窄接口。写接口的风控比读严得多，拆开才能给它单独限流和审计 ——
 * 也让轮询这条路径**在类型上就拿不到写能力**。
 */

/** 只读。聚合流 + 心跳，一轮一个请求。 */
export interface BiliReader {
  fetchFeed(opts?: { offset?: string | null }): Promise<Result<FeedPage>>
  /** feed/all/update 心跳：比 baseline 新的有几条，比拉全量便宜。 */
  countSince(baseline: string): Promise<Result<number>>
  /**
   * 单个 UP 的空间流。轮询不用它 —— 它是阅读页翻历史用的，
   * 因为抓取地板之前的投稿在本地库里根本不存在。
   */
  fetchSpace(opts: { uid: string; offset?: string | null }): Promise<Result<FeedPage>>
}

export interface FeedPage {
  items: ParsedDynamic[]
  hasMore: boolean
  offset: string | null
  /** 下一轮心跳用的游标（B 站的 update_baseline）。 */
  baseline: string | null
  /** 形状不认识、没解析出来的条数。>0 时不该推进 baseline，否则这些条目就永久看不见了。 */
  unparsed: number
}

/**
 * 已由 infra 解析并校验过的一条动态（zod 在 infra 边界跑完，穿过来就是确定类型）。
 * raw 留着是为了事后核对 parser —— 五类 payload 的精确形状是本设计里的未验证项之一。
 */
export interface ParsedDynamic {
  dynId: string
  uid: string
  uname: string
  face: string | null
  type: DynamicType
  pubTs: number
  title: string | null
  text: string | null
  /** 视频简介 / 专栏摘要。只参与过滤匹配，不入库。 */
  desc: string | null
  cover: string | null
  /** 图文的多图（含封面那张）。只有阅读页用，不落库。 */
  pics: string[]
  bvid: string | null
  url: string
  raw: unknown
}

/** 唯一的写接口。自动关注前先批量查关系，只对缺失的补写。 */
export interface BiliRelationWriter {
  getRelations(uids: string[]): Promise<Result<Map<string, boolean>>>
  follow(uid: string): Promise<Result<void>>
}

/**
 * UP 主名片（昵称 + 头像）。spec 列了四个窄接口，这是第五个 —— 独立出来的理由：
 * 它是个读操作，塞进 `BiliRelationWriter` 会让「订阅页查个昵称」顺带拿到写能力，
 * 而塞进 `BiliReader` 又会让轮询那条路径多认识一个跟聚合流无关的接口。
 */
export interface BiliProfile {
  fetchCard(uid: string): Promise<Result<UpCard>>
}

export interface UpCard {
  uid: string
  name: string
  face: string | null
}

export interface BiliAuth {
  /** 返回二维码内容与轮询用的 key；不落任何密码。 */
  startQrLogin(): Promise<Result<QrLogin>>
  pollQrLogin(qrcodeKey: string): Promise<Result<QrLoginState>>
  /** cookie/info → correspond/1 → cookie/refresh → confirm/refresh 那条链。 */
  refreshCookies(): Promise<Result<void>>
  status(): Promise<Result<AuthStatus>>
}

export interface QrLogin {
  qrcodeKey: string
  url: string
}

export type QrLoginState =
  | { state: 'pending' }
  | { state: 'scanned' }
  | { state: 'expired' }
  | { state: 'confirmed'; uid: string; uname: string }

export interface AuthStatus {
  loggedIn: boolean
  uid: string | null
  uname: string | null
  /** cookie 到期时间（epoch ms），拿不到就是 null。 */
  expiresAt: number | null
  needsRefresh: boolean
}

/** 字幕免登录只会返回空数组，必须带 SESSDATA。 */
export interface SubtitleFetcher {
  fetch(bvid: string): Promise<Result<Cue[] | null>>
  /** 分 P 标题。只有简介兜底那一级要用，所以单独一条而不是塞进 fetch 的返回。 */
  parts(bvid: string): Promise<Result<string[]>>
}
