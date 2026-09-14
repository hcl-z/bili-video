import type { DynamicType } from '#shared/contract/update.ts'
import type { DynamicKind } from '#shared/contract/config.ts'
import type { Cue } from '#shared/contract/summary.ts'
import type { Result } from '#shared/contract/failure.ts'
import type { UpSearchItem } from '#shared/contract/api.ts'

/** B 站 API 拆成四个窄接口。写接口的风控比读严得多，拆开才能给它单独限流和审计 —— 也让轮询应项路径**在类型上就拿不到写能力** */


export interface BiliReader {
  fetchFeed(opts?: { offset?: string | null }): Promise<Result<FeedPage>>

  countSince(baseline: string): Promise<Result<number>>

  fetchSpace(opts: { uid: string; offset?: string | null }): Promise<Result<FeedPage>>
}

export interface FeedPage {
  items: ParsedDynamic[]
  hasMore: boolean
  offset: string | null
  /** 下一轮心跳用的游标（B 站的 update_baseline） */
  baseline: string | null

  unparsed: number
}

/** 已由 infra 解析并校验过的单条动态（zod 在 infra 边界完成，穿过来就是确定类型）。 raw 留着是为了事后核对 parser —— 五类 payload 的精确形状是本设计里的未验证项之一 */
export interface ParsedDynamic {
  dynId: string
  uid: string
  uname: string
  face: string | null
  type: DynamicType
  kinds: DynamicKind[]
  pubTs: number
  title: string | null
  text: string | null
  /** 视频简介 / 专栏摘要。只参与过滤匹配，不入库 */
  desc: string | null
  cover: string | null

  pics: string[]
  bvid: string | null
  url: string
  raw: unknown
}

/** 唯一的写接口。自动关注前先批量查关系，只对缺失的补写 */
export interface BiliRelationWriter {
  getRelations(uids: string[]): Promise<Result<Map<string, boolean>>>
  follow(uid: string): Promise<Result<void>>
}

/** UP 主名片（昵称 + 头像）。spec 列了四个窄接口，这是第五个 —— 独立出来的理由： 它是个读操作，塞进 `BiliRelationWriter` 会让「订阅页查个昵称」顺带拿到写能力， 而塞进 `BiliReader` 又会让轮询应项路径多认识一个跟聚合流无关的接口 */
export interface BiliProfile {
  fetchCard(uid: string): Promise<Result<UpCard>>
  search(name: string): Promise<Result<UpSearchItem[]>>
}

export interface UpCard {
  uid: string
  name: string
  face: string | null
}

export interface BiliAuth {
  /** 返回二维码内容与轮询用的 key；不落任何密码 */
  startQrLogin(): Promise<Result<QrLogin>>
  pollQrLogin(qrcodeKey: string): Promise<Result<QrLoginState>>
  /** cookie/info → correspond/1 → cookie/refresh → confirm/refresh 应项链 */
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
  /** cookie 到期时间（epoch ms），拿不到就是 null */
  expiresAt: number | null
  needsRefresh: boolean
}

/** 字幕免登录只会返回空数组，必须带 SESSDATA */
export interface SubtitleFetcher {
  fetch(bvid: string): Promise<Result<Cue[] | null>>

  parts(bvid: string): Promise<Result<string[]>>
}

/** cookie 存取。加密落库（和 SESSDATA 同一套 secret-box），因为 SESSDATA 就等于账号本身。 是 port 而不是 infra 内部类型：`app/auth-lifecycle` 要问「还有多久到期」， `/api/system` 要把它显示出来，两处都不应认识 SQLite */
export interface CookieJar {
  /** 拼好的 `Cookie` 请求头；空 jar 返回空串 */
  header(): string
  get(name: string): string | null
  /** `bili_jct`，写接口和续期链都要带它做 csrf */
  csrf(): string | null
  /** 从响应的 Set-Cookie 头数组写入（`res.headers.getSetCookie()`） */
  setFromResponse(setCookie: string[], now: number): void
  clear(): void
  names(): string[]
  /** 最早到期的应项的时间戳；会话 cookie（没有到期时间）不参与。null = 无从判断 */
  earliestExpiry(): number | null
  isEmpty(): boolean
}
