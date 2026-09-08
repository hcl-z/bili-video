import type { DegradePath, TranscriptSource } from '#shared/contract/summary.ts'

/**
 * 降级路径状态机：subtitle → asr → meta-only → link-only。
 *
 * 只有拿到了语音内容才算高置信度；没拿到就必须标低，正文里也要写明。
 */
export interface DegradeLevel {
  degradePath: DegradePath
  confidence: 'high' | 'low'
}

export function degradeFor(source: TranscriptSource): DegradeLevel {
  switch (source) {
    case 'subtitle':
      return { degradePath: 'subtitle', confidence: 'high' }
    case 'asr':
      return { degradePath: 'asr', confidence: 'high' }
    case 'none':
      return { degradePath: 'meta-only', confidence: 'low' }
  }
}
