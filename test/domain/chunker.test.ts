import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Cue } from '#shared/contract/summary.ts'
import { chunkCues } from '../../src/server/domain/chunker.ts'

/**
 * 分段是纯函数，所以 token 计数也注入进来：每条固定 10，边界就能算得准，
 * 不然测的是 gpt-tokenizer 而不是分段逻辑。
 */
const TEN = (): number => 10

/** 连续的字幕条（条间空 1 秒，够不上停顿），pauses 里的下标前面额外空 gapSec。 */
function cues(n: number, pauses: { at: number; gapSec: number }[] = []): Cue[] {
  const out: Cue[] = []
  let t = 0
  for (let i = 0; i < n; i += 1) {
    const gap = pauses.find((p) => p.at === i)?.gapSec ?? 0
    t += gap
    out.push({ from: t, to: t + 4, text: `第 ${i} 句` })
    t += 5
  }
  return out
}

describe('转写分段', () => {
  it('刚好等于阈值不分段，多一点就分', () => {
    const items = cues(10)
    const cfg = { thresholdTokens: 100, sizeTokens: 50, overlapTokens: 0 }

    const whole = chunkCues(items, cfg, TEN)
    assert.equal(whole.length, 1)
    assert.equal(whole[0]?.tokens, 100)
    assert.equal(whole[0]?.cues.length, 10)

    assert.ok(chunkCues(items, { ...cfg, thresholdTokens: 99 }, TEN).length > 1)
  })

  it('只够两段时切在字幕条边界，时间范围仍是原视频的', () => {
    const items = cues(10)
    const out = chunkCues(items, { thresholdTokens: 99, sizeTokens: 50, overlapTokens: 0 }, TEN)

    assert.equal(out.length, 2)
    assert.deepEqual(
      out.map((c) => c.cues.length),
      [5, 5],
    )
    assert.equal(out[0]?.startSec, items[0]?.from)
    assert.equal(out[1]?.startSec, items[5]?.from)
    assert.equal(out[1]?.endSec, items[9]?.to)
    // 每条字幕都得有归宿，一条都不能漏。
    assert.equal(out.reduce((n, c) => n + c.cues.length, 0), 10)
  })

  it('切点优先落在停顿处，重叠区跨过停顿点也从字幕条开头起', () => {
    // 6 号前空 5 秒、4 号前空 3 秒：两个停顿都在第一段的回看窗口里。
    const items = cues(12, [
      { at: 4, gapSec: 3 },
      { at: 6, gapSec: 5 },
    ])
    const out = chunkCues(items, { thresholdTokens: 100, sizeTokens: 70, overlapTokens: 25 }, TEN)

    // 第一段本该收 7 条，切点让给了间隔更大的那个停顿。
    assert.equal(out[0]?.cues.length, 6)
    assert.equal(out[0]?.endSec, items[5]?.to)
    // 重叠回退 2 条后又挪到了 4 号那个停顿上，仍然是整条字幕。
    assert.equal(out[1]?.startSec, items[4]?.from)
    assert.ok(out[1]!.startSec < out[0]!.endSec)
    for (const c of out) assert.ok(c.cues.length > 0)
    assert.equal(out[out.length - 1]?.endSec, items[11]?.to)
  })

  it('空字幕给空段，全是空白的也一样', () => {
    const cfg = { thresholdTokens: 100, sizeTokens: 50, overlapTokens: 0 }
    assert.deepEqual(chunkCues([], cfg, TEN), [])
    assert.deepEqual(chunkCues([{ from: 0, to: 1, text: '  ' }], cfg, TEN), [])
  })
})
