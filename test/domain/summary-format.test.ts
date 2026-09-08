import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseSummaryDraft,
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
  it('解析模型回的 JSON：容忍围栏、字符串秒数、缺 desc', () => {
    const reply = [
      '好的，这是结果：',
      '```json',
      '{"tldr":"讲了一件事","points":["要点一","要点二"],',
      ' "chapters":[{"startSec":"83","title":"开场"},{"startSec":120,"title":"正题","desc":" 细节 "}]}',
      '```',
    ].join('\n')

    const parsed = parseSummaryDraft(reply)
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.value.tldr, '讲了一件事')
    assert.deepEqual(parsed.value.chapters[0], { startSec: 83, title: '开场', desc: null, summary: '' })
    assert.equal(parsed.value.chapters[1]?.desc, '细节')
  })

  it('形状不对时给出人话原因，不抛异常', () => {
    assert.equal(parseSummaryDraft('我不知道').ok, false)
    assert.equal(parseSummaryDraft('{"tldr":"一句话","points":["要点一"]}').ok, false)
    const bad = parseSummaryDraft('{"tldr":"","points":[]}')
    assert.equal(bad.ok, false)
    if (bad.ok) return
    assert.match(bad.failure.message, /形状不对|解不开/)
  })

  it('字幕转文本带时间戳，空行丢掉', () => {
    const text = transcriptText([
      { from: 0, to: 5, text: '开头' },
      { from: 5, to: 8, text: '  ' },
      { from: 83, to: 90, text: '后面' },
    ])
    assert.equal(text, '[00:00] 开头\n[01:23] 后面')
  })

  it('Markdown 全文里章节链接带 ?t=，低置信度写进正文', () => {
    const md = renderMarkdown(META, {
      tldr: '一句话',
      points: ['要点一'],
      overview: '第一段。\n\n第二段。',
      keyInfo: { terms: [{ name: 'WBI', desc: '一种签名' }], facts: ['吞吐 3 倍'], resources: [] },
      chapters: [{ startSec: 83, title: '开场', desc: null, summary: '开场讲了背景。' }],
      transcriptSource: 'none',
      confidence: 'low',
      degradePath: 'meta-only',
    })
    assert.match(md, /^# 视频标题/)
    assert.match(md, /\[01:23\]\(https:\/\/www\.bilibili\.com\/video\/BV1x\?t=83\) 开场/)
    assert.match(md, /低置信度/)
    assert.match(md, /## 全文总结/)
    assert.match(md, /\*\*WBI\*\*：一种签名/)
    assert.match(md, /开场讲了背景。/)
  })
})
