const TIME = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** 列表里的时间一律 `MM-DD HH:mm`。 */
export const formatTime = (ms: number): string => TIME.format(ms)

export const videoUrl = (bvid: string): string => `https://www.bilibili.com/video/${bvid}`
