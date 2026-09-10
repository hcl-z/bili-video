import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { MIN_KEY_LENGTH, loadMasterKey } from '../src/server/infra/secret/key-manager.ts'
import { maskSecret, open, parseBox, seal } from '../src/server/infra/secret/secret-box.ts'
import { openCore } from '../src/server/server.ts'
import { FakeClock } from './fakes/clock.ts'
import { CollectingLogger } from './fakes/logger.ts'
import { InMemoryEventBus } from '../src/server/infra/event-bus/in-memory.ts'

const dirs: string[] = []
function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bili-video-secret-'))
  dirs.push(dir)
  return dir
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const KEY = 'a'.repeat(32)

describe('secret-box', () => {
  it('原样往返，密文里看不见明文', () => {
    const plaintext = 'SESSDATA=abc%2Cdef%2Cfg*1; 中文也要能过'
    const box = seal(plaintext, KEY)

    assert.equal(open(box, KEY), plaintext)
    assert.equal(box.v, 1)
    assert.ok(!JSON.stringify(box).includes('SESSDATA'))
  })

  it('每次 seal 的 salt 与 iv 都不同：同明文不产生同密文', () => {
    const a = seal('same', KEY)
    const b = seal('same', KEY)

    assert.notEqual(a.salt, b.salt, 'salt 必须随机')
    assert.notEqual(a.iv, b.iv, 'iv 必须随机')
    assert.notEqual(a.data, b.data)
    assert.equal(open(b, KEY), 'same')
  })

  it('错误的 key 解不开（GCM tag 校验失败）', () => {
    const box = seal('secret', KEY)
    assert.throws(() => open(box, 'b'.repeat(32)))
  })

  it('密文被改一个字节就解不开', () => {
    const box = seal('secret', KEY)
    const bytes = Buffer.from(box.data, 'base64')
    bytes[0] = bytes[0]! ^ 0xff
    assert.throws(() => open({ ...box, data: bytes.toString('base64') }, KEY))
  })

  it('parseBox 拒绝乱七八糟的 JSON', () => {
    assert.throws(() => parseBox('not json'))
    assert.throws(() => parseBox('{"v":1}'))
    assert.deepEqual(parseBox(JSON.stringify(seal('x', KEY))).v, 1)
  })

  it('掩码不泄漏中段', () => {
    assert.equal(maskSecret(''), '')
    assert.equal(maskSecret('abcd'), '****')
    assert.equal(maskSecret('abcdefgh'), 'a******h')
    assert.equal(maskSecret('sk-1234567890abcdef'), 'sk******ef')
    assert.ok(!maskSecret('sk-1234567890abcdef').includes('1234'))
  })
})

describe('master key', () => {
  it('首次启动用「临时文件 + rename」原子写出 0600 的 key，不留 .tmp', () => {
    const dir = freshDir()
    const path = join(dir, 'nested', 'master.key')

    const first = loadMasterKey({ path })
    assert.equal(first.created, true)
    assert.equal(first.source, 'file')
    assert.ok(first.key.length >= MIN_KEY_LENGTH)
    assert.ok(existsSync(path))
    assert.equal(statSync(path).mode & 0o777, 0o600, 'key 文件只能自己读写')
    assert.deepEqual(
      readdirSync(join(dir, 'nested')).filter((f) => f.endsWith('.tmp')),
      [],
      '不该留下临时文件',
    )


    const second = loadMasterKey({ path })
    assert.equal(second.key, first.key)
    assert.equal(second.created, false)
  })

  it('key 文件存在但内容无效时直接报错，绝不悄悄生成新 key', () => {
    const dir = freshDir()
    const path = join(dir, 'master.key')
    writeFileSync(path, '   \n')
    const before = readFileSync(path, 'utf8')

    assert.throws(() => loadMasterKey({ path }), /不会自动重新生成/)
    assert.equal(readFileSync(path, 'utf8'), before, '报错时不该覆写原文件')
  })

  it('env passphrase 优先，且拒绝弱口令', () => {
    const dir = freshDir()
    const path = join(dir, 'master.key')

    const strong = 'x'.repeat(MIN_KEY_LENGTH)
    const loaded = loadMasterKey({ path, passphrase: strong })
    assert.deepEqual(loaded, { key: strong, created: false, source: 'env' })
    assert.equal(existsSync(path), false, '走 env 时不该落盘')

    assert.throws(() => loadMasterKey({ path, passphrase: 'short' }), /太短/)
  })
})

function core(dir: string, extra: { masterKeyPassphrase?: string } = {}) {
  return openCore({
    dataDir: dir,
    clock: new FakeClock(),
    logger: new CollectingLogger(),
    events: new InMemoryEventBus(),
    ...extra,
  })
}

describe('secret store', () => {
  it('落库是密文，读回是明文，重启后仍解得开', () => {
    const dir = freshDir()

    const a = core(dir)
    a.secrets.set('ai.apiKey', 'sk-live-0123456789')
    assert.equal(a.secrets.get('ai.apiKey'), 'sk-live-0123456789')
    assert.equal(a.secrets.has('ai.apiKey'), true)

    const stored = String(
      a.db.prepare('SELECT blob_json FROM secrets WHERE key = ?').get('ai.apiKey')!['blob_json'],
    )
    assert.ok(!stored.includes('sk-live'), '库里不能有明文')
    a.close()


    const b = core(dir)
    assert.equal(b.secrets.get('ai.apiKey'), 'sk-live-0123456789')
    assert.deepEqual(b.secrets.keys(), ['ai.apiKey'])

    const desc = b.secrets.describe('ai.apiKey')
    assert.ok(desc)
    assert.equal(desc.length, 'sk-live-0123456789'.length)
    assert.ok(!desc.masked.includes('live'))

    b.secrets.delete('ai.apiKey')
    assert.equal(b.secrets.get('ai.apiKey'), null)
    assert.equal(b.secrets.has('ai.apiKey'), false)
    b.close()
  })

  it('缺 master key 而库里已有密文时启动报错，而不是静默降级', () => {
    const dir = freshDir()

    const a = core(dir)
    a.secrets.set('bili.sessdata', 'x'.repeat(40))
    a.close()

    rmSync(join(dir, 'master.key'))

    assert.throws(() => core(dir), /解不开它们/)
  })

  it('库里没有密文时首次生成 key 是正常的开机路径', () => {
    const dir = freshDir()
    const c = core(dir)
    assert.equal(c.secrets.keys().length, 0)
    c.close()
  })
})
