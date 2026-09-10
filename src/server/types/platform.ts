import type { AppEvent, LogLine } from '#shared/contract/events.ts'

/** 时间是依赖，不是全局。退避、cron、免扰时段、24h 补推窗口全都要靠推进假时钟来测， 直接调 Date.now() 的话这些分支只能靠真等 */
export interface Clock {

  now(): number
  sleep(ms: number): Promise<void>
  /** 注册一个 cron 任务，返回取消函数 */
  schedule(cron: string, task: () => void | Promise<void>): Cancel
  /** 表达式合法吗。返回可读的错误，null = 合法。 归时钟管而不是单开一个接口：cron 的语义（六位含秒）本来就是调度器定的。 假时钟也必须真解析 —— 「非法表达式当场拒绝」正是要测的应项行为 */
  checkCron(cron: string): string | null
}

export type Cancel = () => void

/** SSE 只是它的一个订阅者，业务代码无法识别 SSE */
export interface EventBus {
  emit(event: AppEvent): void
  on(handler: (event: AppEvent) => void): Cancel

  emitLog(line: LogLine): void
  onLog(handler: (line: LogLine) => void): Cancel
}

/** 日志是依赖接口，因为真实实现（pino + pino-roll）会起 worker 线程写文件 —— 测试里换成 收集型实现，进程才不会因为悬着的 transport 不退出 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface Logger {
  trace(obj: object, msg?: string): void
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
  fatal(obj: object, msg?: string): void

  child(bindings: object): Logger

  close(): Promise<void>
}

/** 本地 mlx-audio 和取音频的 yt-dlp 都是本地进程，不走 HTTP， 所以它们是 fetch 之外的第二个进程边界，得单独有个能换测试替身的口子 */
export interface CommandRunner {

  probe(bin: string, args: string[]): Promise<{ found: boolean; detail: string }>
  /** 实际运行单条。非 0 退出不抛 —— yt-dlp 与 mlx_audio 的失败原因都在 stderr 里，得能读到 */
  run(bin: string, args: string[], opts?: RunOptions): Promise<CommandResult>
}

export interface RunOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CommandResult {

  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface RuntimeInfo {
  isDocker: boolean
}
