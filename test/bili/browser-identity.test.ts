import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CHROME_MAJORS,
  createBrowserIdentity,
  parseIdentity,
  serializeIdentity,
} from '../../src/server/infra/bili/browser-identity.ts'

/**
 * 逐请求随机 UA 反而是机器人特征（spec 用户故事 68）。这组测试盯的是两件事：
 * 版本互相咬合，以及一旦生成就不再变。
 */
describe('infra/bili 浏览器身份', () => {
  it('UA 的 Chrome 主版本落在 136–141', () => {
    for (let i = 0; i < 50; i++) {
      const id = createBrowserIdentity()
      const m = /Chrome\/(\d+)\./.exec(id.userAgent)
      assert.ok(m, `UA 里没有 Chrome 版本：${id.userAgent}`)
      assert.ok(
        CHROME_MAJORS.includes(Number(m[1])),
        `${m[1]} 不在 ${CHROME_MAJORS.join('/')} 里`,
      )
    }
  })

  it('sec-ch-ua 的版本和 UA 的主版本一致 —— 两者不咬合是最容易被抓的破绽', () => {
    for (let i = 0; i < 50; i++) {
      const id = createBrowserIdentity()
      const major = /Chrome\/(\d+)\./.exec(id.userAgent)![1]!
      const hint = id.headers['sec-ch-ua']
      assert.ok(hint, 'sec-ch-ua 必须有')
      // 品牌列表里每一个真品牌的 v 都必须是同一个主版本。
      const versions = [...hint.matchAll(/"v="?(\d+)"/g)].map((m) => m[1])
      const brandVersions = [...hint.matchAll(/;v="(\d+)"/g)].map((m) => m[1]!)
      assert.ok(brandVersions.length >= 2, `品牌列表太短：${hint}`)
      assert.ok(
        brandVersions.filter((v) => v === major).length >= 2,
        `sec-ch-ua 里的版本 ${brandVersions.join(',')} 和 UA 的 ${major} 不一致`,
      )
      assert.equal(versions.length, 0) // 只是确认上面那个正则没写错
    }
  })

  it('平台提示与 UA 里的平台一致', () => {
    const id = createBrowserIdentity()
    const platform = id.headers['sec-ch-ua-platform']
    assert.ok(platform)
    if (id.userAgent.includes('Macintosh')) assert.equal(platform, '"macOS"')
    else if (id.userAgent.includes('Windows')) assert.equal(platform, '"Windows"')
    else assert.equal(platform, '"Linux"')
  })

  it('不是移动端', () => {
    assert.equal(createBrowserIdentity().headers['sec-ch-ua-mobile'], '?0')
  })

  it('同一个随机源给出同一个身份（可复现，才能存下来）', () => {
    const fixed = () => 0.42
    assert.deepEqual(createBrowserIdentity(fixed), createBrowserIdentity(fixed))
  })

  it('序列化后能原样读回 —— 重启不换 UA，同一个 cookie 会话里 UA 不该跳变', () => {
    const id = createBrowserIdentity()
    const back = parseIdentity(serializeIdentity(id))
    assert.deepEqual(back, id)
  })

  it('存的内容坏了就返回 null，让调用方重新生成而不是崩', () => {
    assert.equal(parseIdentity('{}'), null)
    assert.equal(parseIdentity('不是 json'), null)
    assert.equal(parseIdentity('{"userAgent":"x"}'), null)
  })
})
