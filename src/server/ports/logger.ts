/**
 * 日志是端口，因为真实实现（pino + pino-roll）会起 worker 线程写文件 —— 测试里换成
 * 收集型实现，进程才不会因为悬着的 transport 不退出。
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface Logger {
  trace(obj: object, msg?: string): void
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
  fatal(obj: object, msg?: string): void
  /** 带固定字段的子 logger，用来给每个模块打 tag。 */
  child(bindings: object): Logger
  /** 关闭底层 transport（真实现要 flush，假实现是 no-op）。 */
  close(): Promise<void>
}
