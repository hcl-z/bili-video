const TIME = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})


export const formatTime = (ms: number): string => TIME.format(ms)

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

/** 大数字加千分位：tokens 动辄五位，不分组读不出量级。分隔符跟数字本身无关，写死 en-US。 */
export const formatCount = (n: number): string => n.toLocaleString('en-US')

/** 一段时长。运行时间和 cookie 剩余有效期共用 —— 同一个量在两处不该长得不一样。 */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

export function formatBytes(n: number): string {
  let value = n
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`
}
