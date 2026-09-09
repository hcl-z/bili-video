import { z } from 'zod'
import { JobStageSchema, JobStatusSchema } from './job.ts'

/**
 * SSE 事件联合类型 —— 前后端唯一真相。后端 emit 与前端分发都从这里取类型，
 * 加一个事件必须先在这里加一个成员。
 */
export const AppEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), at: z.number().int() }),
  z.object({ type: z.literal('update.new'), dynId: z.string(), uid: z.string() }),
  z.object({
    type: z.literal('job.changed'),
    id: z.number().int(),
    /** 页面按 bvid 认这一行，没有它就只能整页重取。 */
    bvid: z.string(),
    status: JobStatusSchema,
    stage: JobStageSchema,
  }),
  z.object({ type: z.literal('summary.done'), bvid: z.string() }),
  z.object({ type: z.literal('poll.finished'), ok: z.boolean(), found: z.number().int() }),
  z.object({ type: z.literal('auth.changed'), loggedIn: z.boolean() }),
  z.object({ type: z.literal('config.changed'), section: z.string() }),
  /** 一轮健康自查跑完了。ok=false 表示这一刻有故障挂着。 */
  z.object({ type: z.literal('health.checked'), ok: z.boolean() }),
])
export type AppEvent = z.infer<typeof AppEventSchema>
export type AppEventType = AppEvent['type']

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
export type LogLevelName = (typeof LOG_LEVELS)[number]

/**
 * 日志页那五档筛选。**不是**级别本身：`all` 不是一个级别，而选 debug 就该只看 debug ——
 * 「这一级及以上」的话 debug 档会连 info 一起收，那它和「全部」就没区别了。
 */
export const LOG_FILTERS = ['all', 'debug', 'info', 'warn', 'error'] as const
export type LogFilter = (typeof LOG_FILTERS)[number]

export function matchesFilter(level: LogLevelName, filter: LogFilter): boolean {
  if (filter === 'all') return true
  // fatal 比 error 更糟，看 error 的时候把它藏起来是个 bug；trace 只在「全部」里露头。
  if (filter === 'error') return level === 'error' || level === 'fatal'
  return level === filter
}

/**
 * 日志走独立的一条流，免得刷日志把主流量挤爆。
 *
 * 结构化字段跟着一起过来。只发 msg 的话，日志页就只剩一句话可看，
 * 而排查时真正要的是 bvid、uid、错误码这些 —— 那正是这几个字段存在的理由。
 */
export const LogLineSchema = z.object({
  at: z.number().int(),
  level: z.enum(LOG_LEVELS),
  /** 模块 tag，来自 `logger.child({ mod })`。没打 tag 的是 null。 */
  mod: z.string().nullable(),
  msg: z.string(),
  /** 其余字段原样带上（不含 mod / err / stack），页面按 `key=value` 铺开。 */
  data: z.record(z.string(), z.unknown()),
  /** 错误摘要，形如 `TypeError: x is not a function`。堆栈只进文件，不进这条流。 */
  err: z.string().nullable(),
})
export type LogLine = z.infer<typeof LogLineSchema>
