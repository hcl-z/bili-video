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

export const JOB_STAGE_LABEL: Record<JobStage, string> = {
  queued: '排队中',
  subtitle: '取字幕',
  download: '下载音频',
  asr: '语音转写',
  chunk: '分段总结',
  reduce: '合并成文',
  persist: '落库',
}

/**
 * 流水线的六步，顺序固定。`queued` 不在里头 —— 那是「还没开始」，不是一步。
 *
 * 页面按这个顺序画一排圆点，点某一步就是「从这儿重跑」。
 */
export const PipelineStepSchema = JobStageSchema.exclude(['queued'])
export type PipelineStep = z.infer<typeof PipelineStepSchema>
export const PIPELINE_STEPS = PipelineStepSchema.options

/**
 * 一步的状态。`reused` 和 `skipped` 分开：前者是「上次的产物还能用」，
 * 后者是「这条路不用走」（有字幕就不下载音频）。混成一个就看不出重跑省了什么。
 */
export const StepStatusSchema = z.enum([
  'pending',
  'running',
  'done',
  'reused',
  'skipped',
  'failed',
])
export type StepStatus = z.infer<typeof StepStatusSchema>

export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: '未开始',
  running: '进行中',
  done: '完成',
  reused: '复用上次的结果',
  skipped: '跳过',
  failed: '失败',
}

export const JobStepSchema = z.object({
  step: PipelineStepSchema,
  status: StepStatusSchema,
  /** 失败原因或跳过理由，给人看的一句话。 */
  note: z.string().nullable(),
  at: z.number().int(),
})
export type JobStep = z.infer<typeof JobStepSchema>

export const SummaryJobSchema = z.object({
  id: z.number().int(),
  bvid: z.string(),
  updateId: z.string(),
  status: JobStatusSchema,
  stage: JobStageSchema,
  attempts: z.number().int(),
  error: z.string().nullable(),
  /** 这一轮从哪一步开始跑；null = 从头。 */
  resumeFrom: PipelineStepSchema.nullable(),
  /** 六步的状态。老任务（这张表之前的）是空数组，页面照旧能显示。 */
  steps: z.array(JobStepSchema),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type SummaryJob = z.infer<typeof SummaryJobSchema>

export const DeliveryKindSchema = z.enum(['discover', 'summary', 'alert', 'digest'])
export type DeliveryKind = z.infer<typeof DeliveryKindSchema>

export const DELIVERY_KIND_LABEL: Record<DeliveryKind, string> = {
  discover: '发现',
  summary: '总结',
  alert: '告警',
  digest: '汇总',
}

export const DeliveryStatusSchema = z.enum(['pending', 'sent', 'failed'])
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>
