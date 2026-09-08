import type { Failure } from '#shared/contract/failure.ts'
import type { PollResult, PollSnapshot } from '#shared/contract/api.ts'
import type { UpdateWithRaw } from '#shared/contract/update.ts'
import { nextAnchors, type AnchorItem } from '../domain/anchor.ts'
import type { BiliReader, ParsedDynamic } from '../ports/bili.ts'
import type { Cancel, Clock } from '../ports/clock.ts'
import type { ConfigStore } from '../ports/config-store.ts'
import type { EventBus } from '../ports/event-bus.ts'
import type { Logger } from '../ports/logger.ts'
import type { AnchorRepo, SubscriptionRepo, UpdateRepo } from '../ports/repo.ts'
import type { StateRepo } from '../ports/state.ts'
import type { RuleService } from './rules.ts'

/** 一轮最多翻几页。停机久了要补的量由 catchup 那一票管，这里只保证不无限翻。 */
const MAX_PAGES = 3
/** 分级退避的上限。再久就该人来看一眼了，继续加倍没意义。 */
const MAX_BACKOFF_MS = 30 * 60_000

export interface PollDeps {
  reader: BiliReader | null
  subs: SubscriptionRepo
  updates: UpdateRepo
  anchors: AnchorRepo
  state: StateRepo
  rules: RuleService
  config: ConfigStore
  clock: Clock
  logger: Logger
  events: EventBus
  /** 登录态可用吗。false 就整轮跳过 —— 没登录的聚合流只会回空或 -101。 */
  loggedIn: () => boolean
  /** 新视频入队用。同步返回、不 await：抓取速度不该被总结拖住。 */
  onVideo: (v: { bvid: string; updateId: string }) => void
}

export class Poller {
  private readonly deps: PollDeps
  private readonly logger: Logger
  private running = false
  private cancelCron: Cancel | null = null
  private cancelConfig: Cancel | null = null
  private cancelAuth: Cancel | null = null
  /** 退避到什么时候。0 = 不在退避中。 */
  private resumeAt = 0
  private consecutiveFailures = 0
  private lastRunAt: number | null = null
  private lastOk: boolean | null = null
  private lastError: string | null = null
  private authStopped = false

  constructor(deps: PollDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'poll' })
  }

  start(): void {
    this.schedule()
    this.cancelConfig = this.deps.config.onChange((section) => {
      if (section === 'poll') this.schedule()
    })
    // 重新登录上了就自动接着轮询，不用重启进程。
    this.cancelAuth = this.deps.events.on((e) => {
      if (e.type === 'auth.changed' && e.loggedIn) this.resume()
    })
  }

  stop(): void {
    this.cancelCron?.()
    this.cancelCron = null
    this.cancelConfig?.()
    this.cancelConfig = null
    this.cancelAuth?.()
    this.cancelAuth = null
  }

  snapshot(): PollSnapshot {
    return {
      status: this.status(),
      lastRunAt: this.lastRunAt,
      lastOk: this.lastOk,
      lastError: this.lastError,
      resumeAt: this.resumeAt === 0 ? null : this.resumeAt,
      consecutiveFailures: this.consecutiveFailures,
    }
  }

  /** 鉴权恢复后重新开工。登录流程成功时调它。 */
  resume(): void {
    this.authStopped = false
    this.resumeAt = 0
    this.consecutiveFailures = 0
    this.schedule()
  }

  /**
   * 一轮轮询。**永不抛**：cron 的回调没人 catch，抛出去就是一次静默的进程级未处理拒绝。
   */
  async pollOnce(): Promise<PollResult> {
    // 单轮加锁：上一轮没跑完这次直接跳过，不排队 —— 排队只会在慢的时候雪崩。
    if (this.running) return skip('上一轮还没跑完，这次跳过')
    const reader = this.deps.reader
    if (reader === null) return skip('读接口未接入')
    if (this.authStopped) return skip('登录已失效，轮询已停止')
    if (!this.deps.loggedIn()) return skip('未登录，跳过这一轮')

    const now = this.deps.clock.now()
    if (this.resumeAt > now) return skip(`退避中，${Math.ceil((this.resumeAt - now) / 1000)}s 后重试`)

    this.running = true
    try {
      const result = await this.round(reader)
      this.lastRunAt = this.deps.clock.now()
      this.lastOk = result.ok
      this.lastError = result.ok ? null : result.reason
      this.deps.events.emit({ type: 'poll.finished', ok: result.ok, found: result.found })
      return result
    } catch (err) {
      // 到这儿说明是 bug（仓储抛了之类），不是业务失败。记下来但别让 cron 崩。
      const reason = err instanceof Error ? err.message : String(err)
      this.logger.error({ err: reason }, '轮询内部出错')
      this.lastRunAt = this.deps.clock.now()
      this.lastOk = false
      this.lastError = reason
      this.deps.events.emit({ type: 'poll.finished', ok: false, found: 0 })
      return { ok: false, found: 0, skipped: 0, blocked: 0, reason }
    } finally {
      this.running = false
    }
  }

  private async round(reader: BiliReader): Promise<PollResult> {
    const baseline = this.deps.state.get('feed-baseline')
    if (baseline !== null) {
      const heartbeat = await reader.countSince(baseline)
      // 心跳失败不算失败：直接去拉全量，别为省一个请求把整轮废掉。
      if (heartbeat.ok && heartbeat.value === 0) {
        return { ok: true, found: 0, skipped: 0, blocked: 0, reason: null }
      }
    }

    const known = new Set(this.deps.subs.list().map((s) => s.uid))
    const anchors = this.deps.anchors.getAll()
    const fresh: ParsedDynamic[] = []
    let offset: string | null = null

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await reader.fetchFeed({ offset })
      if (!res.ok) {
        // 已经拿到过条目就先把它们处理掉，下一轮再从头来 —— 半页比零页有用。
        if (fresh.length === 0) return this.onFailure(res.failure)
        this.backoff(res.failure)
        break
      }
      // baseline 只有第一页给的那个是「最新位置」，后面几页的是往前翻的游标。
      // 有条目没解析出来就不推进：心跳一旦越过它们，它们就再也不会被拉回来。
      if (page === 0 && res.value.baseline !== null && res.value.unparsed === 0) {
        this.deps.state.set('feed-baseline', res.value.baseline)
      }
      this.consecutiveFailures = 0
      this.resumeAt = 0

      const usable = res.value.items.filter(
        (i) => known.has(i.uid) && i.pubTs > (anchors.get(i.uid) ?? 0),
      )
      fresh.push(...usable)
      offset = res.value.offset
      // 这一页一条都不新，说明已经翻到锚点后面了，再翻是白翻。
      if (!res.value.hasMore || offset === null || usable.length === 0) break
    }

    return this.persist(fresh)
  }

  private persist(items: readonly ParsedDynamic[]): PollResult {
    const at = this.deps.clock.now()
    const rows: UpdateWithRaw[] = []
    const marks: AnchorItem[] = []
    let blocked = 0

    for (const item of items) {
      try {
        const ev = this.deps.rules.judge(item.uid, {
          title: item.title,
          text: item.text,
          desc: item.desc,
        })
        const v = ev.verdict
        if (v.kind === 'blocked') blocked += 1
        rows.push({
          dynId: item.dynId,
          uid: item.uid,
          type: item.type,
          pubTs: item.pubTs,
          title: item.title,
          text: item.text,
          cover: item.cover,
          bvid: item.bvid,
          url: item.url,
          raw: item.raw,
          // held（免扰）不算被过滤：它只是先不推，条目本身照常算通过。
          filtered: v.kind === 'blocked',
          filterReason: v.kind === 'pass' ? null : v.reason,
          createdAt: at,
        })
        marks.push({ uid: item.uid, pubTs: item.pubTs, ok: true })
      } catch (err) {
        // 这一条处理不了：锚点就卡在它前面，下一轮再试，别把它跳过去。
        this.logger.error({ dynId: item.dynId, err: String(err) }, '条目处理失败，锚点不越过它')
        marks.push({ uid: item.uid, pubTs: item.pubTs, ok: false })
      }
    }

    const { inserted, skipped } = this.deps.updates.insertMany(rows)
    const byId = new Map(rows.map((r) => [r.dynId, r]))
    for (const dynId of inserted) {
      const row = byId.get(dynId)
      if (row === undefined) continue
      this.deps.events.emit({ type: 'update.new', dynId, uid: row.uid })
      this.offerToQueue(row)
    }

    for (const [uid, ts] of nextAnchors(marks, this.deps.anchors.getAll())) {
      this.deps.anchors.advance(uid, ts, at)
    }

    if (inserted.length > 0) {
      this.logger.info({ inserted: inserted.length, blocked }, '抓到新动态')
    }
    return { ok: true, found: inserted.length, skipped: skipped.length, blocked, reason: null }
  }

  /**
   * 要不要总结这一条。AI 总开关不在这里判 —— 那是队列的事，
   * 这里只管「视频、没被拦、这个 UP 开了总结」。
   */
  private offerToQueue(row: UpdateWithRaw): void {
    if (row.type !== 'AV' || row.bvid === null || row.filtered) return
    if (this.deps.subs.get(row.uid)?.enableAi !== true) return
    try {
      this.deps.onVideo({ bvid: row.bvid, updateId: row.dynId })
    } catch (err) {
      this.logger.error({ bvid: row.bvid, err: String(err) }, '入队失败，不影响这一轮抓取')
    }
  }

  /** 失败分类决定「歇多久」还是「彻底停下」。 */
  private onFailure(failure: Failure): PollResult {
    if (failure.kind === 'auth-lost') {
      this.authStopped = true
      this.cancelCron?.()
      this.cancelCron = null
      this.deps.events.emit({ type: 'auth.changed', loggedIn: false })
      this.logger.error({ msg: failure.message }, '鉴权失效，停止轮询，等重新登录')
    } else {
      this.backoff(failure)
    }
    return { ok: false, found: 0, skipped: 0, blocked: 0, reason: failure.message }
  }

  /** 分级退避：同一类失败连着来就加倍，成功一次立刻清零。 */
  private backoff(failure: Failure): void {
    this.consecutiveFailures += 1
    const base = failure.retryAfterMs ?? 0
    if (base === 0) return
    const wait = Math.min(base * 2 ** (this.consecutiveFailures - 1), MAX_BACKOFF_MS)
    this.resumeAt = this.deps.clock.now() + wait
    this.logger.warn({ kind: failure.kind, waitMs: wait, n: this.consecutiveFailures }, '退避')
  }

  private status(): PollSnapshot['status'] {
    if (this.authStopped) return 'auth-lost'
    if (!this.deps.config.getSection('poll').enabled) return 'disabled'
    if (this.running) return 'running'
    if (this.resumeAt > this.deps.clock.now()) return 'backoff'
    return 'idle'
  }

  private schedule(): void {
    this.cancelCron?.()
    this.cancelCron = null
    const { enabled, cron } = this.deps.config.getSection('poll')
    if (!enabled || this.authStopped) return
    this.cancelCron = this.deps.clock.schedule(cron, async () => {
      await this.pollOnce()
    })
    this.logger.info({ cron }, '轮询已排程')
  }
}

const skip = (reason: string): PollResult => ({
  ok: true,
  found: 0,
  skipped: 0,
  blocked: 0,
  reason,
})
