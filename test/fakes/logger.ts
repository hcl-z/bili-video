import type { Logger, LogLevel } from '../../src/server/types/platform.ts'

export interface CapturedLog {
  level: LogLevel
  obj: object
  msg: string | undefined
}

/** 收集型 logger。真实现（pino + pino-roll）会起 worker 线程写文件，测试里用它进程才干净 */
export class CollectingLogger implements Logger {
  readonly lines: CapturedLog[]
  readonly #bindings: object

  constructor(lines: CapturedLog[] = [], bindings: object = {}) {
    this.lines = lines
    this.#bindings = bindings
  }

  #log(level: LogLevel, obj: object, msg?: string): void {
    this.lines.push({ level, obj: { ...this.#bindings, ...obj }, msg })
  }

  trace(obj: object, msg?: string): void {
    this.#log('trace', obj, msg)
  }
  debug(obj: object, msg?: string): void {
    this.#log('debug', obj, msg)
  }
  info(obj: object, msg?: string): void {
    this.#log('info', obj, msg)
  }
  warn(obj: object, msg?: string): void {
    this.#log('warn', obj, msg)
  }
  error(obj: object, msg?: string): void {
    this.#log('error', obj, msg)
  }
  fatal(obj: object, msg?: string): void {
    this.#log('fatal', obj, msg)
  }

  child(bindings: object): Logger {
    return new CollectingLogger(this.lines, { ...this.#bindings, ...bindings })
  }

  async close(): Promise<void> {}


  has(level: LogLevel, needle: string): boolean {
    return this.lines.some(
      (l) => l.level === level && (l.msg ?? '').includes(needle),
    )
  }
}
