import { z } from 'zod'

/** 一条字幕/转写。ASR 与官方字幕归一到同一形状。 */
export const CueSchema = z.object({
  from: z.number(),
  to: z.number(),
  text: z.string(),
})
export type Cue = z.infer<typeof CueSchema>

/** 转写文本的来源，决定这份总结的可信度。 */
export const TranscriptSourceSchema = z.enum(['subtitle', 'asr', 'none'])
export type TranscriptSource = z.infer<typeof TranscriptSourceSchema>

/** 四级降级路径。绝不静默丢弃：走到哪一级都要推，都要标注。 */
export const DegradePathSchema = z.enum(['subtitle', 'asr', 'meta-only', 'link-only'])
export type DegradePath = z.infer<typeof DegradePathSchema>

export const ChapterSchema = z.object({
  /** 秒。推送里渲染成 bilibili.com/video/BVxxx?t=<startSec>。 */
  startSec: z.number().int().min(0),
  title: z.string(),
  desc: z.string().nullable(),
})
export type Chapter = z.infer<typeof ChapterSchema>

export const SummarySchema = z.object({
  bvid: z.string(),
  tldr: z.string(),
  points: z.array(z.string()),
  chapters: z.array(ChapterSchema),
  fullMd: z.string(),
  transcriptSource: TranscriptSourceSchema,
  degradePath: DegradePathSchema,
  /** meta-only 是低置信度，正文里必须写明「未获取语音内容，基于简介推测」。 */
  confidence: z.enum(['high', 'low']),
  createdAt: z.number().int(),
})
export type Summary = z.infer<typeof SummarySchema>
