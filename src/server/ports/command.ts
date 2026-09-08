/**
 * 本地可执行文件。ASR 的 mlx-whisper 和取音频的 ffmpeg 都是本地进程，不走 HTTP，
 * 所以它们是 fetch 之外的第二个进程边界，得单独有个能换假件的口子。
 */
export interface CommandRunner {
  /** 无副作用的存在性探测（`--help` 之类）。found=false 表示 PATH 上没有它。 */
  probe(bin: string, args: string[]): Promise<{ found: boolean; detail: string }>
}
