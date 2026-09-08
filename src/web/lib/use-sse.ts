import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { AppEvent, AppEventType } from '#shared/contract/events.ts'
import { keys } from './query'

/** 哪个事件让哪些查询失效。加事件就在这儿加一行。 */
const AFFECTS: Record<AppEventType, readonly (readonly string[])[]> = {
  hello: [],
  'update.new': [keys.updates],
  'poll.finished': [keys.updates, keys.system],
  'auth.changed': [keys.system],
  'config.changed': [keys.config],
  'job.changed': [],
  'summary.done': [],
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
    }

    for (const type of Object.keys(AFFECTS)) {
      es.addEventListener(type, handle as (e: Event) => void)
    }
    return () => es.close()
  }, [qc])
}
