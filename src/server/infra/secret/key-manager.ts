import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

/**
 * master key 丢失会使已加密的 cookie 与 apiKey 不可恢复。
 * 生成使用临时文件加 rename；已有文件无效时直接抛错而不重新生成；首次生成以 `created: true` 供调用方检查旧密文。
 */
export interface MasterKey {
  key: string
  created: boolean
  source: 'env' | 'file'
}

export const MIN_KEY_LENGTH = 16

export function loadMasterKey(opts: { path: string; passphrase?: string | undefined }): MasterKey {
  const passphrase = opts.passphrase?.trim()
  if (passphrase !== undefined && passphrase !== '') {
    if (passphrase.length < MIN_KEY_LENGTH) {
      throw new Error(
        `MASTER_KEY passphrase 太短（${passphrase.length} < ${MIN_KEY_LENGTH}）。` +
          '这是加密所有 cookie 与 apiKey 的根密钥，别用弱口令。',
      )
    }
    return { key: passphrase, created: false, source: 'env' }
  }

  if (existsSync(opts.path)) {
    const raw = readFileSync(opts.path, 'utf8').trim()
    if (raw.length < MIN_KEY_LENGTH) {
      // 空文件或被截断的文件。这里生成新 key 会让库里的密文全部变成垃圾，所以只能报错。
      throw new Error(
        `master key 文件 ${opts.path} 存在但内容无效（长度 ${raw.length}）。` +
          '不会自动重新生成 —— 那会让已加密的 cookie 与 apiKey 全部不可恢复。' +
          '请从备份恢复这个文件，或删掉它并接受重新登录与重填 apiKey。',
      )
    }
    return { key: raw, created: false, source: 'file' }
  }

  return { key: generateKeyFile(opts.path), created: true, source: 'file' }
}

/** 临时文件 + rename：中途断电只会留下一个 .tmp，不会留下半个 master.key。 */
function generateKeyFile(path: string): string {
  const key = randomBytes(32).toString('base64')
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(tmp, `${key}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp)
    throw err
  }
  return key
}
