import type { Subscription } from '#shared/contract/subscription.ts'
import { fail, ok, type Result } from '#shared/contract/failure.ts'
import { parseUid } from '../domain/subscription.ts'
import type { BiliProfile, BiliRelationWriter } from '../ports/bili.ts'
import type { Clock } from '../ports/clock.ts'
import type { Logger } from '../ports/logger.ts'
import type { SubscriptionRepo } from '../ports/repo.ts'

export interface SubscriptionDeps {
  subs: SubscriptionRepo
  clock: Clock
  logger: Logger
  /** null = 关注适配器还没接上（或本进程不装）。订阅照样能加，只是关不上。 */
  relations: BiliRelationWriter | null
  /**
   * 自动关注的总开关，用时读（页面上改完下一次就生效）。
   *
   * 适配器里也挡了一道 —— 那道是防「换个调用方绕过去」的硬闸，
   * 这道是为了连查关系那个读请求都省掉，并且给一句不像故障的提示。
   */
  autoFollow: () => boolean
  /** null = 查不到昵称头像，退回用 uid 当名字，不因此拒绝订阅。 */
  profile: BiliProfile | null
}

/** 三个 per-UP 开关的补丁。缺省字段表示不改。 */
export interface TogglePatch {
  enableDynamic?: boolean
  enableVideo?: boolean
  enableAi?: boolean
}

/**
 * 订阅 = 登录小号的关注列表，所以「加订阅」是两件事：入库 + 关注。
 *
 * 两件事都可能单独失败，而它们的重要性不一样：入库失败等于什么都没发生；
 * 关注失败只是「暂时收不到这个人的动态」，订阅本身还在，稍后重试即可。
 * 所以 add 的返回值把这两层分开 —— sub 是结果，notice 是「还差一步」。
 */
export interface AddOutcome {
  sub: Subscription
  /** 关注没成功时的人话原因；成功就是 null。 */
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

  /**
   * 粘一个 uid 或空间链接就完成订阅。
   *
   * 认不出 uid 是用户输入问题（fatal，页面照原样显示）；查名片失败不拦路。
   */
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

    // 已存在就只更新名片，不动三个开关 —— 重复粘一次不该把用户的设置重置掉。
    this.deps.subs.upsert({
      uid,
      name: card.name,
      face: card.face,
      enableDynamic: existing?.enableDynamic ?? true,
      enableVideo: existing?.enableVideo ?? true,
      enableAi: existing?.enableAi ?? true,
    })

    const followed = await this.ensureFollowed([uid])
    return ok({ sub: this.require(uid), notice: followed.notice })
  }

  remove(uid: string): void {
    // 只删订阅，不取消关注：取关是另一个写请求，删一行本地记录不值得去碰风控面。
    this.deps.subs.remove(uid)
    this.logger.info({ uid }, '已删除订阅（B 站上的关注保持不变）')
  }

  setToggles(uid: string, patch: TogglePatch): Subscription | null {
    const cur = this.deps.subs.get(uid)
    if (cur === null) return null
    this.deps.subs.upsert({
      uid,
      name: cur.name,
      face: cur.face,
      enableDynamic: patch.enableDynamic ?? cur.enableDynamic,
      enableVideo: patch.enableVideo ?? cur.enableVideo,
      enableAi: patch.enableAi ?? cur.enableAi,
      followedAt: cur.followedAt,
    })
    // 开关不缓存在任何地方，轮询每轮从库里读，所以改完下一轮就生效，不用重启。
    return this.require(uid)
  }

  /** 启动时补关注：所有还没关上的订阅，一次批量查关系，只补缺的。 */
  async syncFollows(): Promise<{ followed: number; notice: string | null }> {
    const pending = this.deps.subs
      .list()
      .filter((s) => s.followedAt === null)
      .map((s) => s.uid)
    if (pending.length === 0) return { followed: 0, notice: null }

    const r = await this.ensureFollowed(pending)
    return { followed: r.followed.length, notice: r.notice }
  }

  /**
   * 判据 3 与 7 都落在这个方法上：**先批量查一次关系，只对确实没关注的发写请求**。
   *
   * 反过来（先发关注、错了再说）会把系统里唯一的写接口调用次数放大好几倍，
   * 而写接口的风控比读严得多 —— 这是参考实现里专门留了注释的一条。
   */
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
      this.logger.warn({ uids, msg: known.failure.message }, '查关系失败，这一轮不补关注')
      return { followed: [], notice: `查关注关系失败：${known.failure.message}` }
    }

    const followed: string[] = []
    let notice: string | null = null

    for (const uid of uids) {
      if (known.value.get(uid) === true) {
        // 已经关注了，一个写请求都不发。这正是先查再写的全部意义。
        this.deps.subs.markFollowed(uid, this.deps.clock.now())
        this.logger.debug({ uid }, '已在关注列表里，跳过写请求')
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

  /**
   * 查名片。失败就退回已有的那份 —— 订阅本身比昵称重要。
   *
   * 头像和昵称一起退回：upsert 是无条件覆盖 face 的，只退回昵称的话，
   * 名片接口抽风时重复粘一次已有订阅就会把头像清空。
   */
  private async fetchCard(
    uid: string,
    existing: Subscription | null,
  ): Promise<{ name: string; face: string | null }> {
    const profile = this.deps.profile
    if (profile !== null) {
      const card = await profile.fetchCard(uid)
      if (card.ok) return { name: card.value.name, face: card.value.face }
      this.logger.warn({ uid, msg: card.failure.message }, '查 UP 主名片失败，先用 uid 占位')
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
