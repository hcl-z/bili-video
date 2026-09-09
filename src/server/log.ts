import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
// 具名导入：pino 的 .d.ts 里 default 导出解析成命名空间，不可调用；`{ pino }` 才是函数。
import { pino, type Logger as PinoLogger } from 'pino'

import type { LogLine } from '#shared/contract/events.ts'
import { toLogLine } from './log-fields.ts'
import type { Logger, LogLevel } from './ports/logger.ts'

export interface LoggerOptions {
  level: LogLevel
  /** 日志目录；null 表示只往 stdout 写（容器里就是这样）。 */
  dir: string | null
  retentionDays: number
  /** 容器里输出结构化 JSON，本地输出人能读的一行一条。 */
  json: boolean
  /** 关掉 stdout 那一路。只给测试用 —— 否则日志会混进测试输出里。 */
  stdout?: boolean
  /** 每条日志同时喂给它，供 /api/logs/stream 用。 */
  sink?: ((line: LogLine) => void) | undefined
}

/**
 * transport 目标表。单独导出是为了能直接断言「保留天数换算成保留份数」这类意图 ——
 * 这些参数错了不会报错，只会安静地把磁盘写满或把日志提前删掉。
 */
export function buildTargets(opts: LoggerOptions): pino.TransportTargetOptions[] {
  // json=true 走裸 stdout（容器里由 docker logs 收走）；否则用 pino-pretty 给人看。
  // pino-pretty 只在 devDependencies 里 —— 容器是 --prod 安装 + json=true，走不到这条分支。
  const targets: pino.TransportTargetOptions[] =
    opts.stdout === false
      ? []
      : [
          opts.json
            ? { target: 'pino/file', options: { destination: 1 }, level: opts.level }
            : {
                target: 'pino-pretty',
                level: opts.level,
                options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
              },
        ]

  if (opts.dir !== null) {
    targets.push({
      target: 'pino-roll',
      level: opts.level,
      options: {
        file: join(opts.dir, 'app'),
        extension: '.log',
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',
        mkdir: true,
        // 保留份数 = 保留天数：一天一个文件，超出的最旧的自动删。
        limit: { count: opts.retentionDays, removeOtherLogFiles: true },
      },
    })
  }

  return targets
}

export function createLogger(opts: LoggerOptions): Logger {
  if (opts.dir !== null) mkdirSync(opts.dir, { recursive: true })
  const targets = buildTargets(opts)

  const root = pino(
    { level: opts.level, base: undefined, timestamp: pino.stdTimeFunctions.epochTime },
    pino.transport({ targets }),
  )
  return new PinoLoggerAdapter(root, opts.sink)
}

class PinoLoggerAdapter implements Logger {
  private readonly p: PinoLogger
  private readonly sink: ((line: LogLine) => void) | undefined
  /** bindings 再存一份：pino 不把它们回吐出来，而 sink 要靠 `mod` 认出这行是谁打的。 */
  private readonly bindings: object

  constructor(p: PinoLogger, sink: ((line: LogLine) => void) | undefined, bindings: object = {}) {
    this.p = p
    this.sink = sink
    this.bindings = bindings
  }

  #write(level: LogLevel, obj: object, msg?: string): void {
    this.p[level](obj, msg)
    if (this.sink === undefined) return
    this.sink(toLogLine(Date.now(), level, { ...this.bindings, ...obj }, msg ?? ''))
  }

  trace(obj: object, msg?: string): void {
    this.#write('trace', obj, msg)
  }
  debug(obj: object, msg?: string): void {
    this.#write('debug', obj, msg)
  }
  info(obj: object, msg?: string): void {
    this.#write('info', obj, msg)
  }
  warn(obj: object, msg?: string): void {
    this.#write('warn', obj, msg)
  }
  error(obj: object, msg?: string): void {
    this.#write('error', obj, msg)
  }
  fatal(obj: object, msg?: string): void {
    this.#write('fatal', obj, msg)
  }

  child(bindings: object): Logger {
    return new PinoLoggerAdapter(this.p.child(bindings), this.sink, {
      ...this.bindings,
      ...bindings,
    })
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.p.flush(() => resolve())
    })
  }
}
