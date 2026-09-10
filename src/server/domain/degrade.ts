import type { DegradePath, TranscriptSource } from '#shared/contract/summary.ts'

/** 降级链的四级状态机：subtitle → asr → meta → link。 前三级是「内容从何处来」，link 是「什么都没来，只剩标题和链接」。每退一级都记下原因 —— 「绝不静默丢弃」的意思就是每条视频都能明确说明它为什么走到了这一级 */
export type DegradeStep = 'subtitle' | 'asr' | 'meta' | 'link'

const CHAIN: readonly DegradeStep[] = ['subtitle', 'asr', 'meta', 'link']

const STEP_LABEL: Record<DegradeStep, string> = {
  subtitle: '官方字幕',
  asr: '语音转写',
  meta: '简介兜底',
  link: '仅给链接',
}

export interface DegradeState {
  step: DegradeStep

  reasons: string[]
}

export const startDegrade = (): DegradeState => ({ step: 'subtitle', reasons: [] })


export function degrade(state: DegradeState, reason: string): DegradeState {
  const next = CHAIN[CHAIN.indexOf(state.step) + 1] ?? state.step
  return { step: next, reasons: [...state.reasons, `${STEP_LABEL[state.step]}：${reason}`] }
}

export interface DegradeLevel {
  degradePath: DegradePath
  confidence: 'high' | 'low'
}

/** 只有真拿到了语音内容才算高置信度。 */
export function levelFor(step: DegradeStep): DegradeLevel {
  switch (step) {
    case 'subtitle':
      return { degradePath: 'subtitle', confidence: 'high' }
    case 'asr':
      return { degradePath: 'asr', confidence: 'high' }
    case 'meta':
      return { degradePath: 'meta-only', confidence: 'low' }
    case 'link':
      return { degradePath: 'link-only', confidence: 'low' }
  }
}

export const sourceFor = (step: DegradeStep): TranscriptSource =>
  step === 'subtitle' || step === 'asr' ? step : 'none'
