import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { AppEvent, AppEventType } from '#shared/contract/events.ts'
import { keys } from './query'
import { patchUpFeedItem } from './reader-cache'

/**
 * 哪个事件让哪些查询失效。加事件就在这儿加一行。
 *
 * `keys.upFeed` 故意不在任何一行里 —— 它是无限查询，失效会把每一页都重打一次 B 站。
 * 那条泳道的状态变化走 patchUpFeedItem 就地改。
 */
const AFFECTS: Record<AppEventType, readonly (readonly string[])[]> = {
  hello: [],
  'update.new': [keys.updates, keys.summaries, keys.overview],
  'poll.finished': [keys.updates, keys.summaries, keys.system, keys.overview],
  // 登录态变了也要重取二维码：转到 waiting-scan 的那一刻码才存在。
  'auth.changed': [keys.system, keys.overview, keys.qr],
  'config.changed': [keys.config, keys.ai, keys.overview],
  'job.changed': [keys.jobs, keys.summaries, keys.overview],
  'summary.done': [keys.jobs, keys.summaries, keys.overview],
  'health.checked': [keys.overview],
}

/** 订阅 /api/events，按事件类型失效对应查询。EventSource 自己会重连，掉线不用管。 */
export function useServerEvents(): void {
  const qc = useQueryClient()

  useEffect(() => {
    const es = new EventSource('/api/events')

    const handle = (raw: MessageEvent<string>) => {
      let event: AppEvent
      try {
        event = JSON.parse(raw.data) as AppEvent
      } catch {
        return
      }
      for (const queryKey of AFFECTS[event.type]) {
        void qc.invalidateQueries({ queryKey })
      }
      if (event.type === 'job.changed') {
        patchUpFeedItem(qc, event.bvid, { state: event.status, jobStage: event.stage })
      }
      if (event.type === 'summary.done') {
        patchUpFeedItem(qc, event.bvid, { state: 'done', inDb: true })
      }
      // 深链接进来的右栏是按 dynId 单独取的一条，它不在上面那些 key 底下。
      if (event.type === 'job.changed' || event.type === 'summary.done') {
        void qc.invalidateQueries({ queryKey: [...keys.updates, 'item'] })
      }
    }

    for (const type of Object.keys(AFFECTS)) {
      es.addEventListener(type, handle as (e: Event) => void)
    }
    return () => es.close()
  }, [qc])
}
