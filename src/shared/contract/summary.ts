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

/** 降级路径的中文名。前后端同一份。 */
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

export const ChapterSchema = z.object({
  /** 秒。推送里渲染成 bilibili.com/video/BVxxx?t=<startSec>。 */
  startSec: z.number().int().min(0),
  title: z.string(),
  desc: z.string().nullable(),
  /** 这一章讲了什么，几句话。老数据没有这一段，所以给默认值而不是 nullable。 */
  summary: z.string().default(''),
})
export type Chapter = z.infer<typeof ChapterSchema>

/** 关键信息提取。三组固定分类，比让模型自由发挥「类别」稳。 */
export const KeyInfoSchema = z.object({
  /** 术语、概念、人名：看完总结还想查的那些词。 */
  terms: z.array(z.object({ name: z.string(), desc: z.string() })).default([]),
  /** 数字、结论、明确的判断。 */
  facts: z.array(z.string()).default([]),
  /** 视频里提到的工具、项目、链接、书。 */
  resources: z.array(z.object({ name: z.string(), note: z.string() })).default([]),
})
export type KeyInfo = z.infer<typeof KeyInfoSchema>

/**
 * LLM 只产出这三块，其余字段（来源、降级路径、置信度）由管线填。
 *
 * 模型的回答是一道外边界，所以照样 zod 收干净：会加围栏、会把 startSec 写成字符串、会省掉 desc。
 */
export const SummaryDraftSchema = z.object({
  tldr: z.string().trim().min(1),
  // 要点条数只兜上限：短视频给两条也是能用的总结，为了凑 3 条把整篇丢掉不值。
  points: z.array(z.string().trim().min(1)).min(1).max(8),
  /** 全文总结。几段话，能当文章读；缺了不算失败，短视频未必需要。 */
  overview: z.string().trim().default(''),
  keyInfo: KeyInfoSchema.default({}),
  // 章节目录是交付物的一部分，空的算这次没成，进失败重试而不是产出半份。
  chapters: z
    .array(
      z.object({
        startSec: z.coerce.number().int().min(0),
        title: z.string().trim().min(1),
        desc: z
          .string()
          .nullish()
          .transform((v) => {
            const t = v?.trim() ?? ''
            return t === '' ? null : t
          }),
        summary: z
          .string()
          .nullish()
          .transform((v) => v?.trim() ?? ''),
      }),
    )
    .min(1),
})
export type SummaryDraft = z.infer<typeof SummaryDraftSchema>

/** 简介兜底那一级的产出：没有时间轴就不要章节，编出来的时间戳比没有更糟。 */
export const MetaDraftSchema = SummaryDraftSchema.omit({ chapters: true })
export type MetaDraft = z.infer<typeof MetaDraftSchema>

export const SummarySchema = z.object({
  bvid: z.string(),
  tldr: z.string(),
  points: z.array(z.string()),
  /** 全文总结。老数据和仅给链接那级是空串。 */
  overview: z.string().default(''),
  keyInfo: KeyInfoSchema.default({}),
  chapters: z.array(ChapterSchema),
  fullMd: z.string(),
  transcriptSource: TranscriptSourceSchema,
  degradePath: DegradePathSchema,
  /** meta-only 是低置信度，正文里必须写明「未获取语音内容，基于简介推测」。 */
  confidence: z.enum(['high', 'low']),
  createdAt: z.number().int(),
})
export type Summary = z.infer<typeof SummarySchema>
