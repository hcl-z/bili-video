import type { AsrConfig } from '#shared/contract/config.ts'
import type { Cue } from '#shared/contract/summary.ts'

/** 本地 mlx-audio / 云端两种；容器里只能用云端（拿不到 Metal）。 */
export interface Asr {
  readonly provider: AsrConfig['provider']
  transcribe(audioPath: string, opts?: { language?: string; signal?: AbortSignal }): Promise<Cue[]>
}
