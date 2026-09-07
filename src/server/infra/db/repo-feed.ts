import type { DatabaseSync } from 'node:sqlite'

import type { DynamicType, Update, UpdateWithRaw } from '#shared/contract/update.ts'
import type { AnchorRepo, UpdateRepo } from '../../ports/repo.ts'
import { num, str, strOrNull, toBool, toInt, type Row } from './sqlite.ts'

export class SqliteAnchorRepo implements AnchorRepo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  get(uid: string): number | null {
    const r = this.db.prepare('SELECT last_pub_ts FROM anchors WHERE uid = ?').get(uid)
    return r ? num((r as Row)['last_pub_ts']) : null
  }

  getAll(): Map<string, number> {
    const rows = this.db.prepare('SELECT uid, last_pub_ts FROM anchors').all()
    return new Map(rows.map((r) => [str((r as Row)['uid']), num((r as Row)['last_pub_ts'])]))
  }

  /**
   * 单调推进由 SQL 的 WHERE 保证：并发或乱序的调用都不可能把锚点往回拨，
   * 也就不会因为一次回退把已推过的内容重推一遍。
   */
  advance(uid: string, pubTs: number, at: number): void {
    this.db
      .prepare(
        `INSERT INTO anchors (uid, last_pub_ts, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET last_pub_ts = excluded.last_pub_ts, updated_at = excluded.updated_at
         WHERE excluded.last_pub_ts > anchors.last_pub_ts`,
      )
      .run(uid, pubTs, at)
  }
}

const toUpdate = (r: Row): Update => ({
  dynId: str(r['dyn_id']),
  uid: str(r['uid']),
  type: str(r['type']) as DynamicType,
  pubTs: num(r['pub_ts']),
  title: strOrNull(r['title']),
  text: strOrNull(r['text']),
  cover: strOrNull(r['cover']),
  bvid: strOrNull(r['bvid']),
  url: str(r['url']),
  filtered: toBool(r['filtered']),
  filterReason: strOrNull(r['filter_reason']),
  createdAt: num(r['created_at']),
})

export class SqliteUpdateRepo implements UpdateRepo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /**
   * dyn_id 冲突就跳过。「重复轮询不重复推送」的第一道闸门在这里：
   * 返回的 inserted 才是真正的新内容，调用方按它决定推不推。
   */
  insertMany(updates: UpdateWithRaw[]): { inserted: string[]; skipped: string[] } {
    const stmt = this.db.prepare(
      `INSERT INTO updates
         (dyn_id, uid, type, pub_ts, title, text, cover, bvid, url, raw_json, filtered, filter_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dyn_id) DO NOTHING`,
    )
    const inserted: string[] = []
    const skipped: string[] = []
    this.db.exec('BEGIN')
    try {
      for (const u of updates) {
        const info = stmt.run(
          u.dynId,
          u.uid,
          u.type,
          u.pubTs,
          u.title,
          u.text,
          u.cover,
          u.bvid,
          u.url,
          u.raw === undefined ? null : JSON.stringify(u.raw),
          toInt(u.filtered),
          u.filterReason,
          u.createdAt,
        )
        if (info.changes > 0) inserted.push(u.dynId)
        else skipped.push(u.dynId)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return { inserted, skipped }
  }

  get(dynId: string): Update | null {
    const r = this.db.prepare('SELECT * FROM updates WHERE dyn_id = ?').get(dynId)
    return r ? toUpdate(r as Row) : null
  }

  list(q: { uid?: string; includeFiltered?: boolean; limit: number; before?: number }): Update[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (q.uid !== undefined) {
      where.push('uid = ?')
      args.push(q.uid)
    }
    if (q.includeFiltered !== true) where.push('filtered = 0')
    if (q.before !== undefined) {
      where.push('pub_ts < ?')
      args.push(q.before)
    }
    const sql = `SELECT * FROM updates ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY pub_ts DESC LIMIT ?`
    args.push(q.limit)
    return this.db
      .prepare(sql)
      .all(...args)
      .map((r) => toUpdate(r as Row))
  }

  countSince(ts: number): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM updates WHERE pub_ts >= ?').get(ts)
    return r ? num((r as Row)['n']) : 0
  }
}
