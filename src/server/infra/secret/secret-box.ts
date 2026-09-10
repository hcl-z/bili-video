import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/** AES-256-GCM + scrypt（16 字节随机 salt）。照搬参考实现的落盘方案。 salt 每条密文一份而不是全局一份：泄露单条密文不会让避免的密文的派生密钥也一起可用。 代价是每次解密要跑一次 scrypt（~50ms），所以 SecretStore 会在内存里缓存明文 */
export interface SealedBox {
  v: 1
  salt: string
  iv: string
  tag: string
  data: string
}

const SCRYPT = { N: 16384, r: 8, p: 1 } as const
const KEY_BYTES = 32
const IV_BYTES = 12
const SALT_BYTES = 16

const deriveKey = (masterKey: string, salt: Buffer): Buffer =>
  scryptSync(masterKey, salt, KEY_BYTES, { ...SCRYPT })

export function seal(plaintext: string, masterKey: string): SealedBox {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(masterKey, salt), iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

/** master key 不对、密文被改过、tag 不匹配 —— 三种都抛，绝不返回半个明文 */
export function open(box: SealedBox, masterKey: string): string {
  if (box.v !== 1) throw new Error(`unsupported secret box version: ${String(box.v)}`)
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(masterKey, Buffer.from(box.salt, 'base64')),
    Buffer.from(box.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(box.data, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function parseBox(json: string): SealedBox {
  const raw: unknown = JSON.parse(json)
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('v' in raw) ||
    !('salt' in raw) ||
    !('iv' in raw) ||
    !('tag' in raw) ||
    !('data' in raw)
  ) {
    throw new Error('malformed secret box')
  }
  return raw as SealedBox
}

/** 页面上显示的形态：只有掩码和长度，永远没有明文。 */
export function maskSecret(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length)
  if (value.length <= 8) return `${value.slice(0, 1)}${'*'.repeat(value.length - 2)}${value.slice(-1)}`
  return `${value.slice(0, 2)}${'*'.repeat(6)}${value.slice(-2)}`
}
