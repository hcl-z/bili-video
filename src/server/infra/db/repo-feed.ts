import type { DatabaseSync } from 'node:sqlite'

import type { DynamicType, Update, UpdateWithRaw } from '#shared/contract/update.ts'
import type { AnchorRepo, UpdateRepo } from '../../types/persistence.ts'
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

  /** 单调推进由 SQL 的 WHERE 保证：并发或乱序的调用都不可能把锚点往回拨， 也就不会因为一次回退把已推过的内容重推一次 */
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


  insertMany(
    updates: UpdateWithRaw[],
    opts: { inFeed?: boolean } = {},
  ): { inserted: string[]; skipped: string[] } {
    const inFeed = opts.inFeed !== false
    const stmt = this.db.prepare(
      `INSERT INTO updates
         (dyn_id, uid, type, pub_ts, title, text, cover, bvid, url, raw_json, filtered, filter_reason, created_at, in_feed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dyn_id) DO UPDATE SET
         uid = excluded.uid,
         type = excluded.type,
         pub_ts = excluded.pub_ts,
         title = excluded.title,
         text = excluded.text,
         cover = excluded.cover,
         bvid = excluded.bvid,
         url = excluded.url,
         raw_json = excluded.raw_json,
         filtered = excluded.filtered,
         filter_reason = excluded.filter_reason,
         created_at = excluded.created_at,
         in_feed = 1
       WHERE excluded.in_feed = 1 AND updates.in_feed = 0`,
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
          toInt(inFeed),
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


  getByBvid(bvid: string): Update | null {
    const r = this.db
      .prepare('SELECT * FROM updates WHERE bvid = ? ORDER BY pub_ts DESC LIMIT 1')
      .get(bvid)
    return r ? toUpdate(r as Row) : null
  }

  list(q: {
    uid?: string
    includeFiltered?: boolean
    feedOnly?: boolean
    limit: number
    before?: number
  }): Update[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (q.uid !== undefined) {
      where.push('uid = ?')
      args.push(q.uid)
    }
    if (q.includeFiltered !== true) where.push('filtered = 0')
    if (q.feedOnly === true) where.push('in_feed = 1')
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

  count(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM updates').get()
    return r ? num((r as Row)['n']) : 0
  }
}
