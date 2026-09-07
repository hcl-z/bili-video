import { z } from 'zod'

import { fail, ok, type Result } from '#shared/contract/failure.ts'
import { authLostFailure, fatalFailure, shapeFailure } from '../../domain/bili-error.ts'
import { isFollowing } from '../../domain/subscription.ts'
import type { BiliRelationWriter } from '../../ports/bili.ts'
import type { Clock } from '../../ports/clock.ts'
import type { CookieJar } from '../../ports/cookie-jar.ts'
import type { Logger } from '../../ports/logger.ts'
import type { WriteAuditRepo } from '../../ports/repo.ts'
import type { BiliHttp } from './http-client.ts'

const RELATIONS_URL = 'https://api.bilibili.com/x/relation/relations'
const MODIFY_URL = 'https://api.bilibili.com/x/relation/modify'
/** fids 一次问太多会被拒。50 个一批，够 3–5 个订阅用一万年。 */
const BATCH_SIZE = 50
const HOUR_MS = 3_600_000

/** 关注操作的来源标记，B 站要求带；11 = 空间页。 */
const FOLLOW_SOURCE = '11'

/** data 是 `{ "<uid>": { attribute } }`。多余字段一律不管，B 站随时会加。 */
const RelationsSchema = z.record(z.string(), z.object({ attribute: z.number() }))

export interface WriteLimits {
  /**
   * 总开关。false = 一个写请求都不发。
   *
   * 小号真的开始吃 -352 的时候得有地方踩刹车，而 `maxPerHour` 最小是 1、关不掉。
   * spec 把「自动关注的风控表现」列为未测风险，未测的东西就得能关。
   */
  autoFollow: boolean
  /** 两次写调用之间至少隔这么久。 */
  minIntervalMs: number
  /** 一小时最多几次写调用。数的是审计表，所以重启不会白送额度。 */
  maxPerHour: number
}

export interface BiliRelationsDeps {
  http: BiliHttp
  cookies: CookieJar
  clock: Clock
  logger: Logger
  audit: WriteAuditRepo
  limits: () => WriteLimits
}

/**
 * 全系统唯一的写接口适配器。
 *
 * 三件事只在这里做，别处都不许：查关系（读，不限流）、关注（写，限流 + 审计）、
 * 以及「已经关注了就不发写请求」—— 后者由调用方按 getRelations 的结果决定，
 * 但限流和留痕必须在这一层兜住，否则换个调用方就绕过去了。
 */
export class BiliRelationsClient implements BiliRelationWriter {
  private readonly deps: BiliRelationsDeps
  private readonly logger: Logger
  /** 写请求排成一条队。见 `follow` 的注释。 */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(deps: BiliRelationsDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'bili-relations' })
  }

  /** 批量查关系。一个请求问一批，不逐个问 —— 逐个问就是把读接口也变成风控面。 */
  async getRelations(uids: string[]): Promise<Result<Map<string, boolean>>> {
    const out = new Map<string, boolean>()
    if (uids.length === 0) return ok(out)

    for (let i = 0; i < uids.length; i += BATCH_SIZE) {
      const batch = uids.slice(i, i + BATCH_SIZE)
      const res = await this.deps.http.get<unknown>(RELATIONS_URL, { fids: batch.join(',') })
      if (!res.ok) return res

      // data 空着按「这批都没关注」算，但要留一行日志。
      //
      // 两个方向都有代价：当空表会多发写请求（幂等、有审计、受限流，最多一次一个人），
      // 当失败则会在「新号一个都没关注」这个首次使用的场景里把功能整个卡死。
      // 没法验证 B 站到底回 `{}` 还是 `null`（社区文档仓库已下架），所以选前者，
      // 但不让它静默 —— 日志里连着出现就说明猜错了。
      if (res.value === undefined || res.value === null) {
        this.logger.warn({ count: batch.length }, 'relation/relations 没给 data，按都没关注处理')
      }
      const parsed = RelationsSchema.safeParse(res.value ?? {})
      if (!parsed.success) return fail(shapeFailure('relation/relations', res.value))

      // 响应里没出现的 uid 就是没关注 —— B 站对陌生人干脆不给条目。
      for (const uid of batch) {
        const entry = parsed.data[uid]
        out.set(uid, entry !== undefined && isFollowing(entry.attribute))
      }
    }
    return ok(out)
  }

  /**
   * 关注一个人。**全过程串行**：限流读的是审计表，而审计行要等请求回来才落 ——
   * 并发进来的两次调用会各自读到「额度没用、也没人刚写过」，然后一起发出去。
   * 撞得上：启动期补关注和页面上一次新增订阅，或者两个标签页各点一次「重试关注」。
   * 队列本身就是限流的一部分，不是性能优化。
   */
  follow(uid: string): Promise<Result<void>> {
    const run = this.tail.then(
      () => this.followOne(uid),
      () => this.followOne(uid),
    )
    // 队尾只用来排序，不许让上一次的失败把整条链染成 rejected。
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async followOne(uid: string): Promise<Result<void>> {
    const csrf = this.deps.cookies.csrf()
    if (csrf === null) {
      // 没有 bili_jct 就没登录。这时候发出去必然 -111，白记一笔风控。
      return fail(authLostFailure('没有 bili_jct，无法关注（需要先扫码登录）'))
    }

    const gated = await this.gate()
    if (!gated.ok) return gated

    const res = await this.deps.http.postForm<unknown>(
      MODIFY_URL,
      { fid: uid, act: '1', re_src: FOLLOW_SOURCE, csrf },
      // 写请求绝不自动重放：风控重试一次会变成两次关注，审计也就对不上账了。
      { noRetry: true, referer: `https://space.bilibili.com/${uid}` },
    )

    this.record(uid, res)
    if (!res.ok) {
      this.logger.warn({ uid, kind: res.failure.kind, msg: res.failure.message }, '关注失败')
      return res
    }
    this.logger.info({ uid }, '已关注')
    return ok(undefined)
  }

  /**
   * 写接口的独立限流：先看小时额度，再卡最小间隔。
   *
   * 额度用满是**非终态**的 rate-limit 而不是 fatal：等一会儿就能继续，
   * 页面上该显示「稍后重试」，不该显示「关注失败，去查配置」。
   */
  private async gate(): Promise<Result<void>> {
    const { autoFollow, minIntervalMs, maxPerHour } = this.deps.limits()
    if (!autoFollow) {
      // 挡在这一层而不是只挡在 app 层：换个调用方就绕过去的开关不算刹车。
      return fail(fatalFailure('自动关注已关闭（配置 bili.write.autoFollow），没有发出写请求'))
    }
    const now = this.deps.clock.now()

    const used = this.deps.audit.countSince(now - HOUR_MS)
    if (used >= maxPerHour) {
      const message = `写接口一小时限额已用满（${used}/${maxPerHour}），稍后再试`
      this.logger.warn({ used, maxPerHour }, message)
      return fail({ kind: 'rate-limit', code: null, message, retryAfterMs: HOUR_MS })
    }

    const last = this.deps.audit.lastAt()
    if (last !== null) {
      const wait = minIntervalMs - (now - last)
      // 睡着等而不是报错：批量补关注时这是正常节流，不是失败。
      if (wait > 0) await this.deps.clock.sleep(wait)
    }
    return ok(undefined)
  }

  private record(uid: string, res: Result<unknown>): void {
    this.deps.audit.record({
      api: 'relation/modify',
      target: uid,
      ok: res.ok,
      kind: res.ok ? null : res.failure.kind,
      code: res.ok ? null : res.failure.code,
      message: res.ok ? null : res.failure.message,
      at: this.deps.clock.now(),
    })
  }
}
