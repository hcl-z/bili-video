const TIME = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** 列表里的时间一律 `MM-DD HH:mm`。 */
export const formatTime = (ms: number): string => TIME.format(ms)

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

/** 大数字加千分位：tokens 动辄五位，不分组读不出量级。分隔符跟数字本身无关，写死 en-US。 */
export const formatCount = (n: number): string => n.toLocaleString('en-US')
