/**
 * 本地 mlx-audio 和取音频的 yt-dlp 都是本地进程，不走 HTTP，
 * 所以它们是 fetch 之外的第二个进程边界，得单独有个能换假件的口子。
 */
export interface CommandRunner {
  /** 无副作用的存在性探测（`--help` 之类）。found=false 表示 PATH 上没有它。 */
  probe(bin: string, args: string[]): Promise<{ found: boolean; detail: string }>
  /** 真跑一条。非 0 退出不抛 —— yt-dlp 与 mlx_audio 的失败原因都在 stderr 里，得能读到。 */
  run(bin: string, args: string[], opts?: RunOptions): Promise<CommandResult>
}

export interface RunOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CommandResult {
  /** 被信号杀掉时是 null。 */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}
