/** yt-dlp 子进程。匿名请求会 412，必须带登录 cookie。 */
export interface AudioDownloader {
  download(bvid: string, opts?: { signal?: AbortSignal }): Promise<DownloadedAudio>
  /** 跑完即删；失败保留待查；超过 24h 的孤儿文件启动时清理。 */
  cleanup(path: string): Promise<void>
  sweepOrphans(olderThanMs: number): Promise<number>
}

export interface DownloadedAudio {
  path: string
  bytes: number
  durationSec: number | null
}
