import type { PipelineStep } from '#shared/contract/job.ts'
import { PIPELINE_STEPS } from '#shared/contract/job.ts'

/**
 * 流水线的纯规则：谁产出什么、从某一步重跑要作废哪些产物。
 *
 * 「从任意一步重跑」的正确性全靠这张表 —— 少作废一个，重跑出来的东西就是半新半旧的。
 */

/** 三样能落盘的中间产物。persist 不产出产物，它产出的是 summaries 那一行。 */
export type ArtifactKind = 'transcript' | 'notes' | 'draft'

const PRODUCES: Record<PipelineStep, ArtifactKind | null> = {
  subtitle: 'transcript',
  download: null,
  asr: 'transcript',
  chunk: 'notes',
  reduce: 'draft',
  persist: null,
}

const ORDER: Record<PipelineStep, number> = {
  subtitle: 0,
  download: 1,
  asr: 2,
  chunk: 3,
  reduce: 4,
  persist: 5,
}

export const stepIndex = (step: PipelineStep): number => ORDER[step]

export const atOrAfter = (step: PipelineStep, from: PipelineStep): boolean =>
  stepIndex(step) >= stepIndex(from)

/** 从 from 开始重跑时，这些产物必须重算。 */
export function staleArtifacts(from: PipelineStep): ArtifactKind[] {
  const kinds = new Set<ArtifactKind>()
  for (const step of PIPELINE_STEPS) {
    const kind = PRODUCES[step]
    if (kind !== null && atOrAfter(step, from)) kinds.add(kind)
  }
  return [...kinds]
}

/** 转写那一段（字幕 / 下音频 / 转写）要不要重跑。 */
export const needsTranscript = (from: PipelineStep): boolean => stepIndex(from) <= ORDER.asr
