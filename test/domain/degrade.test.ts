import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { degrade, levelFor, sourceFor, startDegrade } from '../../src/server/domain/degrade.ts'

describe('降级状态机', () => {
  it('四级依次往下退，每退一级记一条原因', () => {
    let s = startDegrade()
    assert.equal(s.step, 'subtitle')

    s = degrade(s, '没有字幕')
    assert.equal(s.step, 'asr')

    s = degrade(s, '转写失败')
    assert.equal(s.step, 'meta')

    s = degrade(s, '模型没回 JSON')
    assert.equal(s.step, 'link')

    assert.deepEqual(s.reasons, ['官方字幕：没有字幕', '语音转写：转写失败', '简介兜底：模型没回 JSON'])
  })

  it('最后一级再退还是它，但原因照样记下', () => {
    const link = degrade(degrade(degrade(startDegrade(), 'a'), 'b'), 'c')
    const again = degrade(link, 'd')
    assert.equal(again.step, 'link')
    assert.equal(again.reasons.length, 4)
  })

  it('只有拿到语音内容才算高置信度', () => {
    assert.deepEqual(levelFor('subtitle'), { degradePath: 'subtitle', confidence: 'high' })
    assert.deepEqual(levelFor('asr'), { degradePath: 'asr', confidence: 'high' })
    assert.deepEqual(levelFor('meta'), { degradePath: 'meta-only', confidence: 'low' })
    assert.deepEqual(levelFor('link'), { degradePath: 'link-only', confidence: 'low' })

    assert.equal(sourceFor('asr'), 'asr')
    assert.equal(sourceFor('meta'), 'none')
    assert.equal(sourceFor('link'), 'none')
  })
})
