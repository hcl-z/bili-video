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
])
export type AppEvent = z.infer<typeof AppEventSchema>
export type AppEventType = AppEvent['type']

/** 日志走独立的一条流，免得刷日志把主流量挤爆。 */
export const LogLineSchema = z.object({
  at: z.number().int(),
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  msg: z.string(),
})
export type LogLine = z.infer<typeof LogLineSchema>
