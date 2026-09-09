import { Hono } from 'hono'

import type {
  ReaderItem,
  RunAllSummariesResponse,
  SummariesResponse,
  SummaryDetailResponse,
  TranscriptResponse,
  UpsMap,
} from '#shared/contract/api.ts'
import { SummariesQuerySchema } from '#shared/contract/api.ts'
import type { SummaryQueue } from '../../app/queue-runner.ts'
import { feedState } from '../../domain/summary-format.ts'
import type { Ports } from '../../ports/index.ts'
import { errorBody } from '../errors.ts'
import { fromUpdate } from '../reader-item.ts'

/** 批量补队一次最多看这么多条。索引本身是翻页的，这个只管 run-all。 */
const INDEX_LIMIT = 100
/**
 * 一页要多取几条动态：只有带 bvid 的才进这个索引，碎动态会被筛掉，
 * 按 limit 原样取会让「还有没有下一页」判错。
 */
const OVERFETCH = 3

/** 宽松校验：BV 号长度历史上变过，只挡明显不是 id 的东西（路径穿越、超长串）。 */
const BVID = /^[A-Za-z0-9]{3,24}$/

/** 分栏阅读的两个端点：左边索引一次拉齐，右边点一条拉一条。 */
export function summaryRoutes(ports: Ports, queue: SummaryQueue): Hono {
  const { updates, summaries, jobs, llmCalls, deliveries, subscriptions } = ports.repos

  const upsMap = (): UpsMap => {
    const ups: UpsMap = {}
    for (const s of subscriptions.list()) ups[s.uid] = { name: s.name, face: s.face }
    return ups
  }

  return new Hono()
    .get('/', (c) => {
      const q = SummariesQuerySchema.safeParse(c.req.query())
      if (!q.success) return c.json(errorBody('invalid-request', '查询参数不对'), 400)

      const rows = updates.list({
        limit: q.data.limit * OVERFETCH,
        includeFiltered: true,
        ...(q.data.before === undefined ? {} : { before: q.data.before }),
      })
      const items: ReaderItem[] = []
      let filteredCount = 0
      let scanned = 0
      // 只列视频：其余四类动态永远不会有总结，它们在动态流和阅读页的 UP 泳道里。
      for (const u of rows) {
        if (items.length >= q.data.limit) break
        scanned += 1
        if (u.bvid === null) continue
        // 按库里的标记数，不按条目状态数：「被拦下」不是一条动态的状态（见 readerItem）。
        if (u.filtered) filteredCount += 1
        items.push(fromUpdate(ports, u))
      }

      // 游标按**扫到哪一行**给，不按最后一条视频给 —— 尾巴上全是碎动态时也能往前走。
      const lastScanned = rows[scanned - 1]
      const more = scanned < rows.length || rows.length === q.data.limit * OVERFETCH
      const nextBefore = more && lastScanned !== undefined ? lastScanned.pubTs : null

      const body: SummariesResponse = { items, ups: upsMap(), filteredCount, nextBefore }
      return c.json(body)
    })

    .get('/:bvid', (c) => {
      const bvid = c.req.param('bvid')
      if (!BVID.test(bvid)) return c.json(errorBody('invalid-request', 'bvid 不对'), 400)

      const update = updates.getByBvid(bvid)
      const sub = update === null ? null : subscriptions.get(update.uid)
      const summary = summaries.get(bvid)
      const job = jobs.getByBvid(bvid)
      const body: SummaryDetailResponse = {
        bvid,
        state: feedState(update, job, summary !== null),
        update,
        up: sub === null ? null : { name: sub.name, face: sub.face },
        summary,
        job,
        usage: llmCalls.usageForVideo(bvid),
        deliveries:
          update === null
            ? []
            : deliveries.listForUpdate(update.dynId).map((d) => ({
                channel: d.channel,
                kind: d.kind,
                status: d.status,
                at: d.at,
                error: d.error,
              })),
      }
      // 库里什么都没有也回 200：页面要能显示「这条还没总结」而不是报错。
      return c.json(body)
    })

    /** 完整字幕/转写全文。几万字的东西不塞进详情，谁要看谁单独拉。 */
    .get('/:bvid/transcript', (c) => {
      const bvid = c.req.param('bvid')
      if (!BVID.test(bvid)) return c.json(errorBody('invalid-request', 'bvid 不对'), 400)

      const summary = summaries.get(bvid)
      const text = summaries.transcript(bvid)
      if (summary === null || text === null) {
        return c.json(errorBody('not-found', '这条没有字幕或转写文本'), 404)
      }

      const body: TranscriptResponse = { bvid, source: summary.transcriptSource, text }
      return c.json(body)
    })

    /** 把这一窗里没总结过的都排上队。索引里攒了一堆的时候，不用一条条点。 */
    .post('/run-all', (c) => {
      if (!ports.config.getSection('ai').enabled) {
        return c.json(errorBody('conflict', 'AI 总开关关着，打开后才会跑'), 409)
      }

      let queued = 0
      let skipped = 0
      for (const u of updates.list({ limit: INDEX_LIMIT, includeFiltered: true })) {
        if (u.bvid === null) continue
        const job = jobs.getByBvid(u.bvid)
        const pending = job !== null && job.status !== 'done' && job.status !== 'failed'
        if (u.filtered || pending || summaries.get(u.bvid) !== null) {
          skipped += 1
          continue
        }
        queue.enqueue({ bvid: u.bvid, updateId: u.dynId })
        queued += 1
      }

      const body: RunAllSummariesResponse = { queued, skipped }
      return c.json(body)
    })

    /**
     * 手动排队。轮询只给「新抓到的」入队，所以开关是后来才打开的那些视频
     * 永远等不到自己那一轮 —— 这个端点就是补这个洞。
     */
    .post('/:bvid/run', (c) => {
      const bvid = c.req.param('bvid')
      if (!BVID.test(bvid)) return c.json(errorBody('invalid-request', 'bvid 不对'), 400)

      const update = updates.getByBvid(bvid)
      if (update === null) return c.json(errorBody('not-found', '库里没有这条动态'), 404)
      if (update.filtered) {
        return c.json(errorBody('conflict', '这条被规则拦下了，先去规则页放行'), 409)
      }
      if (!ports.config.getSection('ai').enabled) {
        return c.json(errorBody('conflict', 'AI 总开关关着，打开后才会跑'), 409)
      }

      // 已经有任务的走重跑那条路，免得同一个视频攒出两条任务。
      const existing = jobs.getByBvid(bvid)
      if (existing === null) return c.json(queue.enqueue({ bvid, updateId: update.dynId }))
      if (queue.retry(existing.id) === 'busy') {
        return c.json(errorBody('conflict', '这条已经在队列里了'), 409)
      }
      return c.json(jobs.get(existing.id) ?? existing)
    })
}
