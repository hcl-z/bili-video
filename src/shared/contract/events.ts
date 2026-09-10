import { z } from 'zod'
import { JobStageSchema, JobStatusSchema } from './job.ts'

/** SSE 事件联合类型 —— 前后端唯一真相。后端 emit 与前端分发都从这里取类型， 加一个事件必须先在这里加一个成员 */
export const AppEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), at: z.number().int() }),
  z.object({ type: z.literal('update.new'), dynId: z.string(), uid: z.string() }),
  z.object({
    type: z.literal('job.changed'),
    id: z.number().int(),

    bvid: z.string(),
    status: JobStatusSchema,
    stage: JobStageSchema,
  }),
  z.object({ type: z.literal('summary.done'), bvid: z.string() }),
  z.object({ type: z.literal('poll.finished'), ok: z.boolean(), found: z.number().int() }),
  z.object({ type: z.literal('auth.changed'), loggedIn: z.boolean() }),
  z.object({ type: z.literal('config.changed'), section: z.string() }),

  z.object({ type: z.literal('health.checked'), ok: z.boolean() }),
])
export type AppEvent = z.infer<typeof AppEventSchema>
export type AppEventType = AppEvent['type']

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
export type LogLevelName = (typeof LOG_LEVELS)[number]


export const LOG_FILTERS = ['all', 'debug', 'info', 'warn', 'error'] as const
export type LogFilter = (typeof LOG_FILTERS)[number]

export function matchesFilter(level: LogLevelName, filter: LogFilter): boolean {
  if (filter === 'all') return true

  if (filter === 'error') return level === 'error' || level === 'fatal'
  return level === filter
}


export const LogLineSchema = z.object({
  at: z.number().int(),
  level: z.enum(LOG_LEVELS),

  mod: z.string().nullable(),
  msg: z.string(),

  data: z.record(z.string(), z.unknown()),

  err: z.string().nullable(),
})
export type LogLine = z.infer<typeof LogLineSchema>
