import { z } from 'zod'

import type { Cue } from '#shared/contract/summary.ts'

/** whisper 兼容 JSON：本地 mlx_audio 与云端 OpenAI 兼容端点是同一形状。 */
const WhisperJsonSchema = z.object({
  text: z.string().optional(),
  segments: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
    .optional(),
})

export function parseWhisperJson(raw: unknown): Cue[] {
  const parsed = WhisperJsonSchema.safeParse(raw)
  if (!parsed.success) throw new Error('转写结果不是预期的 whisper JSON 形状')

  const cues = (parsed.data.segments ?? [])
    .map((s) => ({ from: s.start, to: s.end, text: s.text.trim() }))
    .filter((c) => c.text !== '')
  if (cues.length > 0) return cues

  // 只回整段文本（没要到 verbose_json）的话就当这一级不成：没时间轴的「字幕」
  // 会让章节时间戳全落在 0，退到简介兜底反而更诚实。
  if ((parsed.data.text ?? '').trim() !== '') {
    throw new Error('转写结果没有时间轴（端点没回 segments）')
  }
  throw new Error('转写结果是空的')
}
