import type { DatabaseSync } from 'node:sqlite'

import type { StateKey, StateRepo } from '../../ports/state.ts'
import { str, type Row } from './sqlite.ts'

/** runtime_state 表。存的是纯文本，不加密 —— 这里没有秘密，秘密都在 secrets/cookies。 */
export class SqliteStateRepo implements StateRepo {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db
    this.now = now
  }

  get(key: StateKey): string | null {
    const r = this.db.prepare('SELECT value_json FROM runtime_state WHERE key = ?').get(key)
    return r ? str((r as Row)['value_json']) : null
  }

  set(key: StateKey, value: string): void {
    this.db
      .prepare(
        `INSERT INTO runtime_state (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, value, this.now())
  }
}
