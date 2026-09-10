import type { ReaderItem, UpFeedResponse } from '#shared/contract/api.ts'
import { fail, ok, type Result } from '#shared/contract/failure.ts'
import type { SummaryJob } from '#shared/contract/job.ts'
import { fatalFailure } from '../domain/bili-error.ts'
import { readerItem } from '../domain/summary-format.ts'
import type { BiliReader, ParsedDynamic } from '../types/bili.ts'
import type { Clock } from '../types/platform.ts'
import type { Logger } from '../types/platform.ts'
import type { JobRepo, SubscriptionRepo, SummaryRepo, UpdateRepo } from '../types/persistence.ts'
import type { SummaryQueue } from './queue-runner.ts'

/** 阅读页的数据源：某个 UP 的空间流，现拉 B 站。 轮询只抓启动之后新发的，所以历史投稿在本地库里不存在 —— 应项路径就是去够它们的 */

/** 翻过的条目留在内存里，手动排解析时不用为了拿标题再打一次 B 站 */
const CACHE_MAX = 500
/** 缓存里没有应项时，最多往前翻几页去找 */
const LOOKUP_PAGES = 3

export interface UpFeedDeps {
  reader: BiliReader | null
  subs: SubscriptionRepo
  updates: UpdateRepo
  summaries: SummaryRepo
  jobs: JobRepo
  queue: SummaryQueue
  clock: Clock
  logger: Logger
}

export class UpFeedService {
  private readonly deps: UpFeedDeps
  private readonly logger: Logger
  private readonly seen = new Map<string, ParsedDynamic>()

  constructor(deps: UpFeedDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'up-feed' })
  }

  async list(uid: string, offset: string | null): Promise<Result<UpFeedResponse>> {
    const sub = this.deps.subs.get(uid)
    if (sub === null) return fail(fatalFailure('这个 uid 不在订阅里'))
    const reader = this.deps.reader
    if (reader === null) return fail(fatalFailure('读接口未接入'))

    const res = await reader.fetchSpace({ uid, offset })
    if (!res.ok) return res

    this.remember(res.value.items)
    return ok({
      up: { uid: sub.uid, name: sub.name, face: sub.face },
      items: res.value.items.map((i) => this.decorate(i)),
      hasMore: res.value.hasMore,
      offset: res.value.offset,
    })
  }

  /** 手动排单条解析。**先把应项动态落库再入队**：标题、封面、简介兜底都从 updates 里读， 不落库的话总结出来是单条只有 BV 号的空壳。 手动排队不判过滤规则 —— 点了就是意图 */
  async parse(uid: string, dynId: string): Promise<Result<SummaryJob>> {
    const item = await this.locate(uid, dynId)
    if (!item.ok) return item

    const dyn = item.value
    if (dyn.type !== 'AV' || dyn.bvid === null) {
      return fail(fatalFailure('只有视频能解析，这条不是视频'))
    }

    const at = this.deps.clock.now()
    this.deps.updates.insertMany(
      [
        {
          dynId: dyn.dynId,
          uid: dyn.uid,
          type: dyn.type,
          pubTs: dyn.pubTs,
          title: dyn.title,
          text: dyn.text ?? dyn.desc,
          cover: dyn.cover,
          bvid: dyn.bvid,
          url: dyn.url,
          raw: dyn.raw,
          filtered: false,
          filterReason: null,
          createdAt: at,
        },
      ],
      { inFeed: false },
    )
    this.logger.info({ uid, bvid: dyn.bvid, dynId: dyn.dynId }, '手动解析已入队')

    // 已经有任务的走重跑，避免同一个视频攒出两条任务，也避免「重新解析」点了没反应
    const existing = this.deps.jobs.getByBvid(dyn.bvid)
    if (existing === null) {
      return ok(this.deps.queue.enqueue({ bvid: dyn.bvid, updateId: dyn.dynId }))
    }
    if (this.deps.queue.retry(existing.id) === 'busy') return ok(existing)
    return ok(this.deps.jobs.get(existing.id) ?? existing)
  }

  /** 缓存里没有就现翻几页找。翻不到多半是应项已经很老了，让页面提示往下翻 */
  private async locate(uid: string, dynId: string): Promise<Result<ParsedDynamic>> {
    const cached = this.seen.get(dynId)
    if (cached !== undefined) return ok(cached)

    const reader = this.deps.reader
    if (reader === null) return fail(fatalFailure('读接口未接入'))

    let offset: string | null = null
    for (let page = 0; page < LOOKUP_PAGES; page += 1) {
      const res = await reader.fetchSpace({ uid, offset })
      if (!res.ok) return res
      this.remember(res.value.items)
      const hit = res.value.items.find((i) => i.dynId === dynId)
      if (hit !== undefined) return ok(hit)
      offset = res.value.offset
      if (!res.value.hasMore || offset === null) break
    }
    return fail(fatalFailure('在这个 UP 最近的空间流里找不到这条，往下翻一页再试'))
  }

  private remember(items: readonly ParsedDynamic[]): void {
    for (const i of items) {
      this.seen.delete(i.dynId)
      this.seen.set(i.dynId, i)
    }

    while (this.seen.size > CACHE_MAX) {
      const oldest = this.seen.keys().next()
      if (oldest.done === true) break
      this.seen.delete(oldest.value)
    }
  }


  private decorate(i: ParsedDynamic): ReaderItem {
    return readerItem(
      {
        dynId: i.dynId,
        uid: i.uid,
        type: i.type,
        pubTs: i.pubTs,
        title: i.title,
        text: i.text,
        desc: i.desc,
        cover: i.cover,
        pics: i.pics,
        bvid: i.bvid,
        url: i.url,
      },
      {
        update: this.deps.updates.get(i.dynId),
        summary: i.bvid === null ? null : this.deps.summaries.get(i.bvid),
        job: i.bvid === null ? null : this.deps.jobs.getByBvid(i.bvid),
      },
    )
  }
}
