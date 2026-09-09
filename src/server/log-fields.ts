import type { Failure } from '#shared/contract/failure.ts'
import type { LogLevel } from './ports/logger.ts'
import type { LogLine } from '#shared/contract/events.ts'

/**
 * 日志字段的固定写法。零依赖的叶子模块，所以 app 与 infra 都能用它而不破坏依赖方向。
 *
 * 存在的理由是「同一件事在各处长得一样」：错误在哪儿都是 `err` + `stack`，
 * 失败在哪儿都是 `kind` + `code` + `err`。手写字面量的话每个调用点都会长出一套字段名，
 * 于是没法按字段查日志 —— 那正是结构化日志唯一的用处。
 */

/** 抛出来的东西 → 日志字段。堆栈也带上：它只进文件，不进 SSE。 */
export function errFields(err: unknown): { err: string; stack?: string } {
  if (err instanceof Error) {
    const line = err.name === 'Error' ? err.message : `${err.name}: ${err.message}`
    return err.stack === undefined ? { err: line } : { err: line, stack: err.stack }
  }
  return { err: String(err) }
}

/** 失败分类 → 日志字段。`kind` 是这套系统里最值钱的一个维度，别把它埋进句子里。 */
export function failureFields(failure: Failure): {
  kind: Failure['kind']
  code: number | null
  err: string
} {
  return { kind: failure.kind, code: failure.code, err: failure.message }
}

/** 一次耗时。写成字段而不是拼进 msg，否则「哪一步慢」只能靠肉眼读句子。 */
export const tookMs = (startedAt: number, now: number): { ms: number } => ({ ms: now - startedAt })

const RESERVED = new Set(['mod', 'err', 'stack'])

/**
 * 打日志用的对象 → SSE 上那一行。`mod` 与 `err` 单独拎出来，页面才能把它们和
 * 普通字段区别对待（一个当标签，一个标红）；`stack` 直接丢掉，不往浏览器发。
 */
export function toLogLine(at: number, level: LogLevel, obj: object, msg: string): LogLine {
  const fields = obj as Record<string, unknown>
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!RESERVED.has(key) && value !== undefined) data[key] = value
  }
  return {
    at,
    level,
    mod: typeof fields['mod'] === 'string' ? fields['mod'] : null,
    msg,
    data,
    err: typeof fields['err'] === 'string' ? fields['err'] : null,
  }
}
