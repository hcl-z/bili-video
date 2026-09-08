/**
 * 前后端共用的纯格式化。同一个视频的时间戳要在推送的 Markdown 和工作台里长得一样，
 * 所以这几个函数只能有一份。
 */

/** 秒 → `mm:ss`（超过一小时给 `h:mm:ss`）。 */
export function hms(sec: number): string {
  const s = Math.max(0, Math.trunc(sec))
  const mm = String(Math.trunc(s / 60) % 60).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  const h = Math.trunc(s / 3600)
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 视频页地址。拼域名的地方只留这一处。 */
export const videoUrl = (bvid: string): string => `https://www.bilibili.com/video/${bvid}`

/** 章节跳转链接。推送、Markdown 和工作台都点这个直接跳到 B 站的对应时刻。 */
export function chapterLink(bvid: string, startSec: number): string {
  return `${videoUrl(bvid)}?t=${Math.max(0, Math.trunc(startSec))}`
}
