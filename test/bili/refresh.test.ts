import assert from 'node:assert/strict'
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  correspondPath,
  parseCookieInfo,
  parseRefreshCsrf,
  parseRefreshResult,
} from '../../src/server/infra/bili/refresh.ts'

/** 本地密钥对：用它解密就能证明「加的是对的东西、用的是对的填充」。 */
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

describe('infra/bili correspondPath', () => {
  it('加密的明文正是 refresh_<timestamp>', () => {
    const hex = correspondPath(publicKey, 1_700_000_000_000)
    const plain = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(hex, 'hex'),
    ).toString()
    assert.equal(plain, 'refresh_1700000000000')
  })

  it('输出是十六进制（要拼进 URL 路径里）', () => {
    assert.match(correspondPath(publicKey, 1), /^[0-9a-f]+$/)
  })

  it('OAEP 每次输出不同，但都能解回同一明文 —— 不能拿输出当缓存键', () => {
    const a = correspondPath(publicKey, 42)
    const b = correspondPath(publicKey, 42)
    assert.notEqual(a, b)
    for (const hex of [a, b]) {
      const plain = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(hex, 'hex'),
      ).toString()
      assert.equal(plain, 'refresh_42')
    }
  })

  it('公钥没配就抛，说清缺哪一项配置', () => {
    assert.throws(() => correspondPath('   ', 1), /correspondPublicKeyPem/)
  })
})

describe('infra/bili parseRefreshCsrf', () => {
  it('从页面里抠出 refresh_csrf', () => {
    const html = `<!DOCTYPE html><html><body><div id="1-name">abc123DEF</div></body></html>`
    assert.equal(parseRefreshCsrf(html), 'abc123DEF')
  })

  it('抠不到时是 null，而不是空串 —— 空串会带着一个假 csrf 继续走下去', () => {
    assert.equal(parseRefreshCsrf('<html><body>登录后才能看</body></html>'), null)
    assert.equal(parseRefreshCsrf(''), null)
  })
})

describe('infra/bili 续期响应解析', () => {
  it('cookie/info 认 refresh 与 timestamp', () => {
    const out = parseCookieInfo({ refresh: true, timestamp: 1_700_000_000_000 })
    assert.ok(out.ok)
    assert.equal(out.value.refresh, true)
    assert.equal(out.value.timestamp, 1_700_000_000_000)
  })

  it('cookie/info 缺 refresh 字段时是 fatal —— 默认「不用续」会让登录静默过期', () => {
    const out = parseCookieInfo({ timestamp: 1 })
    assert.ok(!out.ok)
    assert.equal(out.failure.kind, 'fatal')
  })

  it('cookie/refresh 的 status 非 0 是终态失败', () => {
    const out = parseRefreshResult({ status: 1, message: '刷新失败', refresh_token: 'x' })
    assert.ok(!out.ok)
    assert.equal(out.failure.kind, 'fatal')
    assert.equal(out.failure.code, 1)
    assert.match(out.failure.message, /刷新失败/)
  })

  it('cookie/refresh 成功时带出新的 refresh_token', () => {
    const out = parseRefreshResult({ status: 0, message: '0', refresh_token: 'new-token' })
    assert.ok(out.ok)
    assert.equal(out.value.refreshToken, 'new-token')
  })

  it('新 token 缺失时是 fatal —— 没有它下一轮续期一定失败', () => {
    const out = parseRefreshResult({ status: 0, message: '0' })
    assert.ok(!out.ok)
    assert.equal(out.failure.kind, 'fatal')
  })
})
