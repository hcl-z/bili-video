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

/** 阶段的中文名。队列页和阅读栏说的必须是同一套话。 */
export const JOB_STAGE_LABEL: Record<JobStage, string> = {
  queued: '排队中',
  subtitle: '取字幕',
  download: '下载音频',
  asr: '语音转写',
  chunk: '分段总结',
  reduce: '合并成文',
  persist: '落库',
}

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
