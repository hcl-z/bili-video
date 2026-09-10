import type { DatabaseSync } from 'node:sqlite'

import type { SecretDescription, SecretKey, SecretStore } from '../../types/persistence.ts'
import { num, str, type Row } from '../db/sqlite.ts'
import { maskSecret, open, parseBox, seal } from './secret-box.ts'

/** secrets 表的读写。明文在内存里缓存 —— 每次解密都要跑一次 scrypt（~50ms）， 而 B 站请求会频繁取 SESSDATA。 get() 返回明文是有意的（服务端要拿它去调外部 API）；「页面上只显示掩码」应项约束 由 HTTP 层只暴露 describe() 来保证 */
export class SqliteSecretStore implements SecretStore {
  readonly #cache = new Map<SecretKey, string>()

  private readonly db: DatabaseSync
  private readonly masterKey: string
  private readonly now: () => number

  constructor(db: DatabaseSync, masterKey: string, now: () => number) {
    this.db = db
    this.masterKey = masterKey
    this.now = now
  }

  get(key: SecretKey): string | null {
    const cached = this.#cache.get(key)
    if (cached !== undefined) return cached

    const r = this.db.prepare('SELECT blob_json FROM secrets WHERE key = ?').get(key)
    if (!r) return null

    const value = open(parseBox(str((r as Row)['blob_json'])), this.masterKey)
    this.#cache.set(key, value)
    return value
  }

  set(key: SecretKey, value: string): void {
    const at = this.now()
    this.db
      .prepare(
        `INSERT INTO secrets (key, blob_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET blob_json = excluded.blob_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(seal(value, this.masterKey)), at)
    this.#cache.set(key, value)
  }

  delete(key: SecretKey): void {
    this.db.prepare('DELETE FROM secrets WHERE key = ?').run(key)
    this.#cache.delete(key)
  }

  has(key: SecretKey): boolean {
    return this.db.prepare('SELECT 1 FROM secrets WHERE key = ?').get(key) !== undefined
  }

  describe(key: SecretKey): SecretDescription | null {
    const r = this.db.prepare('SELECT updated_at FROM secrets WHERE key = ?').get(key)
    if (!r) return null
    const value = this.get(key)
    if (value === null) return null
    return {
      key,
      masked: maskSecret(value),
      length: value.length,
      updatedAt: num((r as Row)['updated_at']),
    }
  }

  keys(): SecretKey[] {
    return this.db
      .prepare('SELECT key FROM secrets ORDER BY key')
      .all()
      .map((r) => str((r as Row)['key']))
  }

  /** 库里有密文而 master key 是新生成的 —— 这种组合只可能是 key 丢了 */
  countStored(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM secrets').get()
    return r ? num((r as Row)['n']) : 0
  }
}
