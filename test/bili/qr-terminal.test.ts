import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderQr } from '../../src/server/infra/bili/qr-terminal.ts'

describe('infra/bili 终端二维码', () => {
  it('渲染出多行字符画', async () => {
    const art = await renderQr('https://qr.example/login?key=abc')
    const lines = art.split('\n').filter((l) => l.trim() !== '')
    assert.ok(lines.length > 10, `只有 ${lines.length} 行，扫不出来`)
    // small 模式用的是半块字符；换成全块会让二维码在多数终端里超高。
    assert.ok(/[█▀▄ ]/.test(art))
  })

  it('内容不同则图不同 —— 否则会打出一张扫了没反应的旧码', async () => {
    assert.notEqual(await renderQr('a'), await renderQr('b'))
  })
})
