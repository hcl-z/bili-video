import type { Cue } from '#shared/contract/summary.ts'

/** 本地 mlx-whisper / 云端 OpenAI 兼容两种实现；容器里只能用后者（拿不到 Metal）。 */
export interface Asr {
  readonly provider: 'mlx-whisper' | 'openai-compat'
  transcribe(audioPath: string, opts?: { language?: string; signal?: AbortSignal }): Promise<Cue[]>
}
