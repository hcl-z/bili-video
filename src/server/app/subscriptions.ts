import type { DynamicKindConfig } from '#shared/contract/config.ts'
import type { UpSearchItem } from '#shared/contract/api.ts'
import type { Subscription } from '#shared/contract/subscription.ts'
import { fail, ok, type Result } from '#shared/contract/failure.ts'
import { fatalFailure } from '../domain/bili-error.ts'
import { isSpaceLink, isWebLink, parseUid } from '../domain/subscription.ts'
import type { BiliProfile, BiliRelationWriter } from '../types/bili.ts'
import type { Clock } from '../types/platform.ts'
import type { Logger } from '../types/platform.ts'
import { failureFields } from '../log-fields.ts'
import type { SubscriptionRepo } from '../types/persistence.ts'

export interface SubscriptionDeps {
  subs: SubscriptionRepo
  clock: Clock
  logger: Logger
  /** null = 关注适配器还没接上（或本进程不装）。订阅照样能加，只是关不上 */
  relations: BiliRelationWriter | null
  /** 自动关注总开关，调用时读取；适配器另行强制校验 */
  autoFollow: () => boolean
  /** null = 查不到昵称头像，退回用 uid 当名字，不因此拒绝订阅 */
  profile: BiliProfile | null
}


export interface TogglePatch {
  enableAi?: boolean
  pushKindMode?: Subscription['pushKindMode']
  pushKinds?: DynamicKindConfig | null
  filterMode?: Subscription['filterMode']
  promptTemplate?: string | null
}

/** 添加订阅包含入库和关注；关注失败不回滚订阅，通过 notice 返回 */
export interface AddOutcome {
  sub: Subscription
  /** 关注没成功时的可读原因；成功就是 null */
  notice: string | null
}

export class SubscriptionService {
  private readonly deps: SubscriptionDeps
  private readonly logger: Logger

  constructor(deps: SubscriptionDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'subscriptions' })
  }

  list(): Subscription[] {
    return this.deps.subs.list()
  }

  get(uid: string): Subscription | null {
    return this.deps.subs.get(uid)
  }

  async resolve(input: string): Promise<Result<UpSearchItem[]>> {
    const query = input.trim()
    if (query === '') return Promise.resolve(fail(fatalFailure('请输入 UP 主名称、UID 或空间页链接')))

    const profile = this.deps.profile
    if (profile === null) return Promise.resolve(fail(fatalFailure('UP 主查找功能未接入')))

    const uid = parseUid(query)
    if (uid !== null) {
      const card = await profile.fetchCard(uid)
      if (card.ok) {
        return ok([
          {
            uid: card.value.uid,
            name: card.value.name,
            face: card.value.face,
            signature: '',
            fans: 0,
          },
        ])
      }
      if (isSpaceLink(query)) return card
    } else if (isWebLink(query)) {
      return Promise.resolve(fail(fatalFailure('这不是 UP 主空间页链接')))
    }

    return profile.search(query)
  }

  /** 粘一个 uid 或空间链接就完成订阅。 无法识别 uid 是用户输入问题（fatal，页面照原样显示）；查名片失败不拦路 */
  async add(input: string): Promise<Result<AddOutcome>> {
    const uid = parseUid(input)
    if (uid === null) {
      return fail({
        kind: 'fatal',
        code: null,
        message: '认不出 uid。粘一串数字，或者 UP 主空间页的链接。',
        retryAfterMs: null,
      })
    }

    const existing = this.deps.subs.get(uid)
    const card = await this.fetchCard(uid, existing)


    this.deps.subs.upsert({
      uid,
      name: card.name,
      face: card.face,
      enableAi: existing?.enableAi ?? true,
      pushKindMode: existing?.pushKindMode ?? 'inherit',
      pushKinds: existing?.pushKinds ?? null,
      filterMode: existing?.filterMode ?? 'inherit',
      promptTemplate: existing?.promptTemplate ?? null,
    })

    const followed = await this.ensureFollowed([uid])
    return ok({ sub: this.require(uid), notice: followed.notice })
  }

  remove(uid: string): void {
    // 只删订阅，不取消关注：取关是另一个写请求，删一行本地记录不值得去碰风控面
    this.deps.subs.remove(uid)
    this.logger.info({ uid }, '订阅已删除')
  }

  setToggles(uid: string, patch: TogglePatch): Subscription | null {
    const cur = this.deps.subs.get(uid)
    if (cur === null) return null
    this.deps.subs.upsert({
      uid,
      name: cur.name,
      face: cur.face,
      enableAi: patch.enableAi ?? cur.enableAi,
      pushKindMode: patch.pushKindMode ?? cur.pushKindMode,
      pushKinds: patch.pushKinds === undefined ? cur.pushKinds : patch.pushKinds,
      filterMode: patch.filterMode ?? cur.filterMode,
      promptTemplate: patch.promptTemplate === undefined ? cur.promptTemplate : patch.promptTemplate,
      followedAt: cur.followedAt,
    })
    // 开关不缓存在任何地方，轮询每轮从库里读，所以改完下一轮就生效，不用重启
    return this.require(uid)
  }

  /** 启动时补关注：所有还没关上的订阅，一次批量查关系，只补缺的 */
  async syncFollows(): Promise<{ followed: number; notice: string | null }> {
    const pending = this.deps.subs
      .list()
      .filter((s) => s.followedAt === null)
      .map((s) => s.uid)
    if (pending.length === 0) return { followed: 0, notice: null }

    const r = await this.ensureFollowed(pending)
    return { followed: r.followed.length, notice: r.notice }
  }

  /** 批量查询关注关系后，仅对未关注用户发送关注请求，以减少写请求和风控风险 */
  async ensureFollowed(uids: string[]): Promise<{ followed: string[]; notice: string | null }> {
    if (uids.length === 0) return { followed: [], notice: null }

    const relations = this.deps.relations
    if (relations === null) {
      return { followed: [], notice: '关注功能未接入，需要手动在 B 站关注 TA' }
    }
    if (!this.deps.autoFollow()) {
      return { followed: [], notice: '自动关注已关闭，需要手动在 B 站关注 TA' }
    }

    const known = await relations.getRelations(uids)
    if (!known.ok) {
      this.logger.warn({ uids: uids.length, ...failureFields(known.failure) }, '关注关系查询失败')
      return { followed: [], notice: `查关注关系失败：${known.failure.message}` }
    }

    const followed: string[] = []
    let notice: string | null = null

    for (const uid of uids) {
      if (known.value.get(uid) === true) {
        // 已经关注了，一个写请求都不发。这正是先查再写的全部意义。
        this.deps.subs.markFollowed(uid, this.deps.clock.now())
        this.logger.debug({ uid }, '已关注，跳过写请求')
        continue
      }
      const done = await relations.follow(uid)
      if (done.ok) {
        this.deps.subs.markFollowed(uid, this.deps.clock.now())
        followed.push(uid)
        continue
      }
      // 一个失败不该拖垮整批：记下第一条原因，剩下的继续试。
      notice ??= `关注失败：${done.failure.message}`
    }
    return { followed, notice }
  }

  /** 查询名片失败时回退已有昵称和头像，避免 upsert 清空头像。 */
  private async fetchCard(
    uid: string,
    existing: Subscription | null,
  ): Promise<{ name: string; face: string | null }> {
    const profile = this.deps.profile
    if (profile !== null) {
      const card = await profile.fetchCard(uid)
      if (card.ok) return { name: card.value.name, face: card.value.face }
      this.logger.warn({ uid, ...failureFields(card.failure) }, 'UP 主名片查询失败')
    }
    return { name: existing?.name ?? `UID ${uid}`, face: existing?.face ?? null }
  }

  /** upsert 之后一定读得到；读不到说明库被并发改了，那是 bug 不是业务分支。 */
  private require(uid: string): Subscription {
    const sub = this.deps.subs.get(uid)
    if (sub === null) throw new Error(`订阅 ${uid} 刚写进去就读不到了`)
    return sub
  }
}
