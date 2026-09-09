import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  leadLine,
  parseArticle,
  renderMarkdown,
  transcriptText,
} from '../../src/server/domain/summary-format.ts'

const META = {
  bvid: 'BV1x',
  title: '视频标题',
  url: 'https://www.bilibili.com/video/BV1x',
  upName: 'UP-111',
}

describe('domain/summary-format', () => {
  it('取模型回的正文：剥掉 Markdown 围栏，空正文算失败', () => {
    const fenced = ['```markdown', '## Overview', '', '讲了一件事。', '```'].join('\n')
    const parsed = parseArticle(fenced)
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.value, '## Overview\n\n讲了一件事。')

    assert.equal(parseArticle('   ').ok, false)
  })

  it('导语取正文首个非标题段落', () => {
    assert.equal(leadLine('## Overview\n\n这个视频讲清了一件事。'), '这个视频讲清了一件事。')
    assert.equal(leadLine('- **要点**：先量再改'), '要点：先量再改')
  })

  it('字幕转文本：时间戳后不留空格，空行与相邻重复行丢掉', () => {
    const text = transcriptText([
      { from: 0, to: 5, text: ' 开  头 ' },
      { from: 5, to: 8, text: '  ' },
      { from: 8, to: 10, text: '开 头' },
      { from: 83, to: 90, text: '后面' },
    ])
    assert.equal(text, '[00:00]开 头\n[01:23]后面')
  })

  it('落盘的 Markdown 带标题链接与降级说明，正文原样附在后面', () => {
    const md = renderMarkdown(META, {
      article: '## [01:23] 开场\n\n开场讲了背景。',
      transcriptSource: 'none',
      confidence: 'low',
      degradePath: 'meta-only',
      reasons: ['官方字幕：没有字幕'],
    })
    assert.match(md, /^# 视频标题/)
    assert.match(md, /<https:\/\/www\.bilibili\.com\/video\/BV1x>/)
    assert.match(md, /低置信度/)
    assert.match(md, /> - 官方字幕：没有字幕/)
    assert.match(md, /开场讲了背景。/)
  })
})
