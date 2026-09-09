import { useEffect, useRef, useState } from 'react'

import type { LogFilter, LogLine } from '#shared/contract/events.ts'

/** 页面上最多留这么多行，再往上翻是去看日志文件的事。 */
const MAX_LINES = 1000
/** 攒一下再渲染：日志能一秒几十行，逐行 setState 会把主线程占满。 */
const FLUSH_MS = 200

/**
 * 订阅 `/api/logs/stream`。筛选在服务端做（换档就重连），
 * 所以选了某一档之后，别的档那些行浏览器根本收不到。
 */
export function useLogStream(
  filter: LogFilter,
  /** 暂停只停住渲染，连接不断：恢复时把这期间攒下的行一次补上。 */
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
