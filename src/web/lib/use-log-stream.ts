import { useEffect, useRef, useState } from 'react'

import type { LogFilter, LogLine } from '#shared/contract/events.ts'


const MAX_LINES = 1000

const FLUSH_MS = 200

/** 订阅 `/api/logs/stream`。筛选在服务端做（换档就重连）， 所以选了某一档之后，避免的档那些行浏览器根本收不到 */
export function useLogStream(
  filter: LogFilter,

  paused = false,
): {
  lines: LogLine[]
  connected: boolean
  clear: () => void
} {
  const [lines, setLines] = useState<LogLine[]>([])
  const [connected, setConnected] = useState(false)
  const pending = useRef<LogLine[]>([])
  const frozen = useRef(paused)
  frozen.current = paused

  useEffect(() => {
    setLines([])
    pending.current = []

    const es = new EventSource(`/api/logs/stream?level=${filter}`)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.addEventListener('log', (raw: MessageEvent<string>) => {
      try {
        pending.current.push(JSON.parse(raw.data) as LogLine)
      } catch {
        // 半行 JSON 直接丢掉，不值得为它把整条流断开。
      }
    })

    const timer = setInterval(() => {
      if (frozen.current || pending.current.length === 0) return
      const batch = pending.current
      pending.current = []
      setLines((prev) => [...prev, ...batch].slice(-MAX_LINES))
    }, FLUSH_MS)

    return () => {
      clearInterval(timer)
      es.close()
    }
  }, [filter])

  return { lines, connected, clear: () => setLines([]) }
}
