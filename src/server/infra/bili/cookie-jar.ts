import type { DatabaseSync } from 'node:sqlite'

import type { CookieJar } from '../../ports/cookie-jar.ts'
import { num, numOrNull, str, type Row } from '../db/sqlite.ts'

/** 加密收口。注入进来而不是直接依赖 master key，jar 才能在没有密钥的测试里被单独驱动。 */
export interface Cipher {
  seal(plaintext: string): string
  open(sealed: string): string
}

export interface ParsedCookie {
  name: string
  value: string
  /** 绝对到期时间（epoch ms）；null = 会话 cookie。 */
  expires: number | null
}

/**
 * 解析一条 Set-Cookie。
 *
 * 关键一点：**Max-Age 换算成绝对时间**再存。存相对秒数的话，重启一次有效期就凭空多出来一截，
 * 于是「还有 20 天」这种显示永远是错的。RFC 6265：Max-Age 优先于 Expires。
 */
export function parseSetCookie(line: string, now: number): ParsedCookie | null {
  const parts = line.split(';')
  const first = parts[0]?.trim() ?? ''
  const eq = first.indexOf('=')
  if (eq <= 0) return null

  const name = first.slice(0, eq).trim()
  // 值里可能还有 `=`（base64），只切第一个。
  const value = first.slice(eq + 1).trim()
  if (name === '') return null

  let expires: number | null = null
  let maxAge: number | null = null
  for (const attr of parts.slice(1)) {
    const i = attr.indexOf('=')
    if (i <= 0) continue
    const k = attr.slice(0, i).trim().toLowerCase()
    const v = attr.slice(i + 1).trim()
    if (k === 'expires') {
      const t = Date.parse(v)
      if (!Number.isNaN(t)) expires = t
    } else if (k === 'max-age') {
      const s = Number(v)
      if (Number.isFinite(s)) maxAge = now + s * 1000
    }
  }

  return { name, value, expires: maxAge ?? expires }
}

/**
 * cookies 表的读写。值加密，到期时间明文（要能用 SQL 直接问「最早什么时候到期」，
 * 而且它本身不是秘密）。
 */
export class SqliteCookieJar implements CookieJar {
  private readonly cache = new Map<string, string>()
  private loaded = false

  private readonly db: DatabaseSync
  private readonly cipher: Cipher
  private readonly now: () => number

  constructor(db: DatabaseSync, cipher: Cipher, now: () => number) {
    this.db = db
    this.cipher = cipher
    this.now = now
  }

  private load(): Map<string, string> {
    if (this.loaded) return this.cache
    for (const row of this.db.prepare('SELECT name, blob_json FROM cookies').all()) {
      const r = row as Row
      this.cache.set(str(r['name']), this.cipher.open(str(r['blob_json'])))
    }
    this.loaded = true
    return this.cache
  }

  header(): string {
    return [...this.load()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  get(name: string): string | null {
    return this.load().get(name) ?? null
  }

  csrf(): string | null {
    return this.get('bili_jct')
  }

  setFromResponse(setCookie: string[], now: number): void {
    const stmt = this.db.prepare(
      `INSERT INTO cookies (name, blob_json, expires, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET blob_json = excluded.blob_json,
         expires = excluded.expires, updated_at = excluded.updated_at`,
    )
    this.load()
    for (const line of setCookie) {
      const c = parseSetCookie(line, now)
      if (c === null) continue
      stmt.run(c.name, this.cipher.seal(c.value), c.expires, this.now())
      this.cache.set(c.name, c.value)
    }
  }

  clear(): void {
    this.db.exec('DELETE FROM cookies')
    this.cache.clear()
    this.loaded = true
  }

  names(): string[] {
    return [...this.load().keys()]
  }

  earliestExpiry(): number | null {
    // 会话 cookie 的 expires 是 NULL，不参与 —— 否则一个 buvid3 就能把有效期算成 0。
    const r = this.db.prepare('SELECT MIN(expires) AS e FROM cookies WHERE expires IS NOT NULL').get()
    return r ? numOrNull((r as Row)['e']) : null
  }

  isEmpty(): boolean {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM cookies').get()
    return r === undefined || num((r as Row)['n']) === 0
  }
}
