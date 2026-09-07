import { z } from 'zod'

export const JobStatusSchema = z.enum(['pending', 'running', 'done', 'failed'])
export type JobStatus = z.infer<typeof JobStatusSchema>

/** 队列页要显示卡在哪一步，所以阶段是显式的而不是一个百分比。 */
export const JobStageSchema = z.enum([
  'queued',
  'subtitle',
  'download',
  'asr',
  'chunk',
  'reduce',
  'persist',
])
export type JobStage = z.infer<typeof JobStageSchema>

export const SummaryJobSchema = z.object({
  id: z.number().int(),
  bvid: z.string(),
  updateId: z.string(),
  status: JobStatusSchema,
  stage: JobStageSchema,
  attempts: z.number().int(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type SummaryJob = z.infer<typeof SummaryJobSchema>

export const DeliveryKindSchema = z.enum(['discover', 'summary', 'alert', 'digest'])
export type DeliveryKind = z.infer<typeof DeliveryKindSchema>

export const DeliveryStatusSchema = z.enum(['pending', 'sent', 'failed'])
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>
