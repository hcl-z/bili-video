import { Hono } from 'hono'

import type {
  SummariesResponse,
  SummaryDetailResponse,
  SummaryFeedItem,
  UpsMap,
} from '#shared/contract/api.ts'
import { feedState } from '../../domain/summary-format.ts'
import type { Ports } from '../../ports/index.ts'
import { errorBody } from '../errors.ts'

/** 索引只取最近这一窗，页头那句「N 条」说的也是这一窗，不是全库。 */
const INDEX_LIMIT = 100

/** 宽松校验：BV 号长度历史上变过，只挡明显不是 id 的东西（路径穿越、超长串）。 */
const BVID = /^[A-Za-z0-9]{3,24}$/

/** 分栏阅读的两个端点：左边索引一次拉齐，右边点一条拉一条。 */
export function summaryRoutes(ports: Ports): Hono {
  const { updates, summaries, jobs, llmCalls, deliveries, subscriptions } = ports.repos

  const upsMap = (): UpsMap => {
    const ups: UpsMap = {}
    for (const s of subscriptions.list()) ups[s.uid] = { name: s.name, face: s.face }
    return ups
  }

  return new Hono()
    .get('/', (c) => {
      const items: SummaryFeedItem[] = []
      let filteredCount = 0
      // 只列视频：其余四类动态永远不会有总结，它们在动态流那一页。
      for (const u of updates.list({ limit: INDEX_LIMIT, includeFiltered: true })) {
        if (u.bvid === null) continue
        const summary = summaries.get(u.bvid)
        const state = feedState(u, jobs.getByBvid(u.bvid), summary !== null)
        if (state === 'filtered') filteredCount += 1
        items.push({
          bvid: u.bvid,
          dynId: u.dynId,
          uid: u.uid,
          title: u.title ?? u.bvid,
          cover: u.cover,
          pubTs: u.pubTs,
          state,
          degradePath: summary?.degradePath ?? null,
          filterReason: u.filterReason,
        })
      }

      const body: SummariesResponse = { items, ups: upsMap(), filteredCount }
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
}
