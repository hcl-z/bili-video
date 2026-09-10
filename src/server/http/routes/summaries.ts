import { Hono } from 'hono'

import type {
  ReaderItem,
  SummariesResponse,
  SummaryDetailResponse,
  TranscriptResponse,
  UpsMap,
} from '#shared/contract/api.ts'
import { SummariesQuerySchema } from '#shared/contract/api.ts'
import type { SummaryQueue } from '../../app/queue-runner.ts'
import { feedState } from '../../domain/summary-format.ts'
import type { ServerDeps } from '../../types/index.ts'
import { errorBody } from '../errors.ts'
import { fromUpdate } from '../reader-item.ts'


const OVERFETCH = 3


const BVID = /^[A-Za-z0-9]{3,24}$/


export function summaryRoutes(deps: ServerDeps, queue: SummaryQueue): Hono {
  const { updates, summaries, jobs, llmCalls, deliveries, subscriptions } = deps.repos

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

      for (const u of rows) {
        if (items.length >= q.data.limit) break
        scanned += 1
        if (u.bvid === null) continue

        if (u.filtered) filteredCount += 1
        items.push(fromUpdate(deps, u))
      }

      // 游标按**扫到哪一行**给，不按最后单条视频给 —— 尾巴上全是碎动态时也能往前走
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

      return c.json(body)
    })


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


    .post('/:bvid/run', (c) => {
      const bvid = c.req.param('bvid')
      if (!BVID.test(bvid)) return c.json(errorBody('invalid-request', 'bvid 不对'), 400)

      const update = updates.getByBvid(bvid)
      if (update === null) return c.json(errorBody('not-found', '库里没有这条动态'), 404)
      if (update.filtered) {
        return c.json(errorBody('conflict', '这条被规则拦下了，先去规则页放行'), 409)
      }
      if (!deps.config.getSection('ai').enabled) {
        return c.json(errorBody('conflict', 'AI 总开关关着，打开后才会跑'), 409)
      }

      // 已经有任务的走重跑应项路，避免同一个视频攒出两条任务
      const existing = jobs.getByBvid(bvid)
      if (existing === null) return c.json(queue.enqueue({ bvid, updateId: update.dynId }))
      if (queue.retry(existing.id) === 'busy') {
        return c.json(errorBody('conflict', '这条已经在队列里了'), 409)
      }
      return c.json(jobs.get(existing.id) ?? existing)
    })
}
