import type { ChunkConfig } from '#shared/contract/config.ts'
import type { Cue } from '#shared/contract/summary.ts'

import { cueLine } from './summary-format.ts'
import { tokensOf } from './token.ts'

/** 一段。cues 原样带着 —— 汇总阶段要靠各段的时间范围把章节时间戳落回原视频。 */
export interface TranscriptChunk {
  index: number
  cues: Cue[]
  startSec: number
  endSec: number
  tokens: number
}

export type TokenCounter = (text: string) => number

/** 字幕条之间空过这么久算一次自然停顿，切点优先落这儿。 */
const PAUSE_SEC = 1.5
/** 往回找停顿的窗口（字幕条数）。找太远会把段切得忽长忽短，反而不如硬切在字幕条边界。 */
const LOOKBACK = 10
/** 重叠起点往回挪的窗口。挪太远的话，实际重叠会比要的大出好几倍。 */
const OVERLAP_LOOKBACK = 3

/**
 * 按 token 阈值把字幕切成段。纯函数：同样的入参永远同样的段。
 *
 * 未超阈值时返回**一段**（调用方据此走整篇总结）；超了才真的分。
 * 切点永远落在字幕条边界上，不会把一句话切两半。
 */
export function chunkCues(
  cues: readonly Cue[],
  cfg: ChunkConfig,
  count: TokenCounter = tokensOf,
): TranscriptChunk[] {
  const items = cues.filter((c) => c.text.trim() !== '')
  if (items.length === 0) return []

  const weights = items.map((c) => count(cueLine(c)))
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= cfg.thresholdTokens) return [chunk(0, items, total)]

  const out: TranscriptChunk[] = []
  let start = 0
  while (start < items.length) {
    let end = start
    let acc = 0
    // 第一条无条件收进来：单条就超 sizeTokens 也得有个归宿，否则这里会空转。
    while (end < items.length && (end === start || acc + weights[end]! <= cfg.sizeTokens)) {
      acc += weights[end]!
      end += 1
    }
    // 下界卡在半段处：让切点去凑停顿是好事，但把一段砍掉一多半就得不偿失了。
    if (end < items.length) {
      end = snapToPause(items, start + Math.ceil((end - start) / 2), end, LOOKBACK)
    }

    const slice = items.slice(start, end)
    out.push(chunk(out.length, slice, sum(weights, start, end)))
    if (end >= items.length) break
    start = overlapStart(items, weights, end, cfg.overlapTokens, start)
  }
  return out
}

const chunk = (index: number, cues: Cue[], tokens: number): TranscriptChunk => ({
  index,
  cues,
  startSec: Math.trunc(cues[0]?.from ?? 0),
  endSec: Math.trunc(cues[cues.length - 1]?.to ?? 0),
  tokens,
})

const sum = (w: number[], from: number, to: number): number =>
  w.slice(from, to).reduce((a, b) => a + b, 0)

/**
 * 把切点挪到 (min, end] 里间隔最大的那个停顿上。一个停顿都没有就留在 end ——
 * 那仍然是字幕条边界，只是不好看。
 */
function snapToPause(items: readonly Cue[], min: number, end: number, lookback: number): number {
  let best = end
  let bestGap = PAUSE_SEC
  for (let b = end; b > Math.max(min, end - lookback); b -= 1) {
    const gap = items[b]!.from - items[b - 1]!.to
    if (gap > bestGap) {
      best = b
      bestGap = gap
    }
  }
  return best
}

/**
 * 下一段的起点：从 end 往回退够 overlapTokens 的量，再挪到停顿上。
 *
 * 重叠是为了让跨段的一句话在两边都完整出现，所以它的起点同样不该落在句子中间。
 * floor 保证每轮至少前进一条，不然重叠会把游标拽回原地。
 */
function overlapStart(
  items: readonly Cue[],
  weights: number[],
  end: number,
  overlapTokens: number,
  floor: number,
): number {
  if (overlapTokens <= 0) return end
  let i = end
  let acc = 0
  while (i > floor + 1 && acc + weights[i - 1]! <= overlapTokens) {
    i -= 1
    acc += weights[i]!
  }
  return i >= end ? end : snapToPause(items, floor + 1, i, OVERLAP_LOOKBACK)
}
