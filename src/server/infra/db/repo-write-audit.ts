import type { DatabaseSync } from 'node:sqlite'

import type { NewWriteCall, WriteAuditRepo, WriteCallRecord } from '../../ports/repo.ts'
import { num, numOrNull, str, strOrNull, toBool, toInt, type Row } from './sqlite.ts'

const toRecord = (r: Row): WriteCallRecord => ({
  id: num(r['id']),
  at: num(r['at']),
  api: str(r['api']),
  target: strOrNull(r['target']),
  ok: toBool(r['ok']),
  kind: strOrNull(r['kind']),
  code: numOrNull(r['code']),
  message: strOrNull(r['message']),
})

/** 写接口的账本。成败都记 —— 失败的那次也真的发出去了，风控照样算它一笔。 */
export class SqliteWriteAuditRepo implements WriteAuditRepo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  record(call: NewWriteCall): void {
    this.db
      .prepare(
        `INSERT INTO bili_write_calls (at, api, target, ok, kind, code, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(call.at, call.api, call.target, toInt(call.ok), call.kind, call.code, call.message)
  }

  countSince(ts: number): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM bili_write_calls WHERE at >= ?').get(ts)
    return num((r as Row)['n'])
  }

  lastAt(): number | null {
    const r = this.db.prepare('SELECT MAX(at) AS at FROM bili_write_calls').get()
    return numOrNull((r as Row)['at'])
  }

  recent(limit: number): WriteCallRecord[] {
    return this.db
      .prepare('SELECT * FROM bili_write_calls ORDER BY at DESC, id DESC LIMIT ?')
      .all(limit)
      .map((r) => toRecord(r as Row))
  }
}
