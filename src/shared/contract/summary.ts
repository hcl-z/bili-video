import { z } from 'zod'

/** 单条字幕/转写。ASR 与官方字幕归一到同一形状 */
export const CueSchema = z.object({
  from: z.number(),
  to: z.number(),
  text: z.string(),
})
export type Cue = z.infer<typeof CueSchema>


export const TranscriptSourceSchema = z.enum(['subtitle', 'asr', 'none'])
export type TranscriptSource = z.infer<typeof TranscriptSourceSchema>

/** 四级降级路径。绝不静默丢弃：走到哪一级都要推，都要标注 */
export const DegradePathSchema = z.enum(['subtitle', 'asr', 'meta-only', 'link-only'])
export type DegradePath = z.infer<typeof DegradePathSchema>

export const DEGRADE_LABEL: Record<DegradePath, string> = {
  subtitle: '官方字幕',
  asr: '语音转写',
  'meta-only': '仅凭简介',
  'link-only': '仅给链接',
}

export const TRANSCRIPT_SOURCE_LABEL: Record<TranscriptSource, string> = {
  subtitle: '来自官方字幕',
  asr: '来自语音转写',
  none: '没有语音内容',
}

export const SummarySchema = z.object({
  bvid: z.string(),

  tldr: z.string(),
  /** 模型回的正文，Markdown。阅读栏直接渲染它 */
  article: z.string(),
  /** 落盘的那份：正文加上标题、链接、来源与降级说明 */
  fullMd: z.string(),
  transcriptSource: TranscriptSourceSchema,
  degradePath: DegradePathSchema,
  /** meta-only 是低置信度，正文里必须写明「未获取语音内容，基于简介推测」 */
  confidence: z.enum(['high', 'low']),
  createdAt: z.number().int(),
})
export type Summary = z.infer<typeof SummarySchema>
