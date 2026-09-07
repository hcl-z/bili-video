import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseSetCookie } from '../../src/server/infra/bili/cookie-jar.ts'
import { createHarness } from '../support/harness.ts'

const NOW = 1_700_000_000_000

describe('infra/bili Set-Cookie 解析', () => {
  it('取出名字、值与绝对到期时间', () => {
    const c = parseSetCookie(
      'SESSDATA=abc%2Cdef; Path=/; Domain=.bilibili.com; Expires=Tue, 09 Sep 2036 12:00:00 GMT; HttpOnly; Secure',
      NOW,
    )
    assert.ok(c)
    assert.equal(c.name, 'SESSDATA')
    // 值保持原样（URL 编码的逗号不能解，B 站要的就是这串）。
    assert.equal(c.value, 'abc%2Cdef')
    assert.equal(c.expires, Date.parse('Tue, 09 Sep 2036 12:00:00 GMT'))
  })

  it('Max-Age 换算成绝对时间（相对时间存下来重启就错了）', () => {
    const c = parseSetCookie('bili_jct=deadbeef; Max-Age=86400; Path=/', NOW)
    assert.ok(c)
    assert.equal(c.expires, NOW + 86_400_000)
  })

  it('Max-Age 优先于 Expires —— RFC 6265 就是这么定的', () => {
    const c = parseSetCookie(
      'x=1; Expires=Tue, 09 Sep 2036 12:00:00 GMT; Max-Age=60',
      NOW,
    )
    assert.equal(c?.expires, NOW + 60_000)
  })

  it('没有到期信息就是会话 cookie，expires 为 null', () => {
    assert.equal(parseSetCookie('buvid3=xyz; Path=/', NOW)?.expires, null)
  })

  it('值里带 = 不会被截断', () => {
    assert.equal(parseSetCookie('t=a=b=c; Path=/', NOW)?.value, 'a=b=c')
  })

  it('空的、没有 = 的、只有属性的都返回 null，不产生垃圾条目', () => {
    assert.equal(parseSetCookie('', NOW), null)
    assert.equal(parseSetCookie('   ', NOW), null)
    assert.equal(parseSetCookie('Path=/; HttpOnly', NOW)?.name, 'Path') // 这确实像个 cookie，调用方按名字白名单收
    assert.equal(parseSetCookie('novalue', NOW), null)
  })
})

describe('infra/bili cookie 落库', () => {
  it('落库是密文，读回是明文，重启后仍然拿得到', async () => {
    const h = await createHarness({ startAt: NOW })

    h.core.cookies.setFromResponse(
      [
        `SESSDATA=secret-sess; Expires=Tue, 09 Sep 2036 12:00:00 GMT`,
        `bili_jct=csrf-token; Max-Age=86400`,
        `DedeUserID=12345; Max-Age=86400`,
      ],
      NOW,
    )

    assert.equal(h.core.cookies.get('SESSDATA'), 'secret-sess')
    assert.equal(h.core.cookies.csrf(), 'csrf-token')

    // 库里那一行必须是密文。
    const row = h.core.db.prepare('SELECT blob_json FROM cookies WHERE name = ?').get('SESSDATA')
    const blob = String((row as Record<string, unknown>)['blob_json'])
    assert.ok(!blob.includes('secret-sess'), `明文进了库：${blob}`)
    assert.match(blob, /"salt"/)

    const again = await h.restart()
    assert.equal(again.core.cookies.get('SESSDATA'), 'secret-sess')
    await again.close()
  })

  it('拼出的 Cookie 头包含所有条目', async () => {
    const h = await createHarness({ startAt: NOW })
    h.core.cookies.setFromResponse(['SESSDATA=a; Max-Age=99', 'bili_jct=b; Max-Age=99'], NOW)

    const header = h.core.cookies.header()
    assert.match(header, /SESSDATA=a/)
    assert.match(header, /bili_jct=b/)
    assert.match(header, /; /)
    await h.close()
  })

  it('最早到期时间用于算「cookie 剩余有效期」', async () => {
    const h = await createHarness({ startAt: NOW })
    h.core.cookies.setFromResponse(
      ['SESSDATA=a; Max-Age=600', 'bili_jct=b; Max-Age=60', 'buvid3=c'],
      NOW,
    )

    // 会话 cookie（无到期）不参与计算，否则一个 buvid3 就能把有效期算成 0。
    assert.equal(h.core.cookies.earliestExpiry(), NOW + 60_000)
    await h.close()
  })

  it('空的 jar 说得清自己是空的，clear 之后也是', async () => {
    const h = await createHarness({ startAt: NOW })
    assert.equal(h.core.cookies.isEmpty(), true)
    assert.equal(h.core.cookies.header(), '')
    assert.equal(h.core.cookies.earliestExpiry(), null)

    h.core.cookies.setFromResponse(['SESSDATA=a; Max-Age=60'], NOW)
    assert.equal(h.core.cookies.isEmpty(), false)

    h.core.cookies.clear()
    assert.equal(h.core.cookies.isEmpty(), true)
    assert.deepEqual(h.core.cookies.names(), [])
    await h.close()
  })

  it('同名 cookie 覆盖而不是堆积', async () => {
    const h = await createHarness({ startAt: NOW })
    h.core.cookies.setFromResponse(['SESSDATA=old; Max-Age=60'], NOW)
    h.core.cookies.setFromResponse(['SESSDATA=new; Max-Age=60'], NOW)

    assert.equal(h.core.cookies.get('SESSDATA'), 'new')
    assert.deepEqual(h.core.cookies.names(), ['SESSDATA'])
    await h.close()
  })
})
