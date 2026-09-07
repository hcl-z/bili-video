import type { DatabaseSync } from 'node:sqlite'

import type { FilterRule, RuleKind, Subscription } from '#shared/contract/subscription.ts'
import type { FilterRuleRepo, SubscriptionRepo } from '../../ports/repo.ts'
import { num, numOrNull, str, strOrNull, toBool, toInt, type Row } from './sqlite.ts'

const toSubscription = (r: Row): Subscription => ({
  uid: str(r['uid']),
  name: str(r['name']),
  face: strOrNull(r['face']),
  enableDynamic: toBool(r['enable_dynamic']),
  enableVideo: toBool(r['enable_video']),
  enableAi: toBool(r['enable_ai']),
  followedAt: numOrNull(r['followed_at']),
})

export class SqliteSubscriptionRepo implements SubscriptionRepo {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db
    this.now = now
  }

  list(): Subscription[] {
    return this.db
      .prepare('SELECT * FROM subscriptions ORDER BY created_at')
      .all()
      .map((r) => toSubscription(r as Row))
  }

  get(uid: string): Subscription | null {
    const r = this.db.prepare('SELECT * FROM subscriptions WHERE uid = ?').get(uid)
    return r ? toSubscription(r as Row) : null
  }

  upsert(sub: Omit<Subscription, 'followedAt'> & { followedAt?: number | null }): void {
    // followed_at 用 COALESCE 保住旧值：改个昵称不该把「已关注」抹掉。
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (uid, name, face, enable_dynamic, enable_video, enable_ai, followed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET
           name = excluded.name,
           face = excluded.face,
           enable_dynamic = excluded.enable_dynamic,
           enable_video = excluded.enable_video,
           enable_ai = excluded.enable_ai,
           followed_at = COALESCE(excluded.followed_at, subscriptions.followed_at)`,
      )
      .run(
        sub.uid,
        sub.name,
        sub.face,
        toInt(sub.enableDynamic),
        toInt(sub.enableVideo),
        toInt(sub.enableAi),
        sub.followedAt ?? null,
        this.now(),
      )
  }

  remove(uid: string): void {
    this.db.prepare('DELETE FROM subscriptions WHERE uid = ?').run(uid)
  }

  markFollowed(uid: string, at: number): void {
    this.db.prepare('UPDATE subscriptions SET followed_at = ? WHERE uid = ?').run(at, uid)
  }
}

const toRule = (r: Row): FilterRule => ({
  id: num(r['id']),
  scope: str(r['scope']),
  kind: str(r['kind']) as RuleKind,
  pattern: str(r['pattern']),
  enabled: toBool(r['enabled']),
})

export class SqliteFilterRuleRepo implements FilterRuleRepo {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db
    this.now = now
  }

  list(): FilterRule[] {
    return this.db
      .prepare('SELECT * FROM filter_rules ORDER BY scope, id')
      .all()
      .map((r) => toRule(r as Row))
  }

  /** 全局 + 该 uid 两个 scope 一起返回，谁覆盖谁由 domain/filter 决定，不在 SQL 里判。 */
  listEffective(uid: string): FilterRule[] {
    return this.db
      .prepare(`SELECT * FROM filter_rules WHERE scope IN ('global', ?) ORDER BY scope, id`)
      .all(uid)
      .map((r) => toRule(r as Row))
  }

  add(rule: { scope: string; kind: RuleKind; pattern: string; enabled: boolean }): FilterRule {
    const info = this.db
      .prepare(
        'INSERT INTO filter_rules (scope, kind, pattern, enabled, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(rule.scope, rule.kind, rule.pattern, toInt(rule.enabled), this.now())
    return { id: Number(info.lastInsertRowid), ...rule }
  }

  setEnabled(id: number, enabled: boolean): void {
    this.db.prepare('UPDATE filter_rules SET enabled = ? WHERE id = ?').run(toInt(enabled), id)
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM filter_rules WHERE id = ?').run(id)
  }
}
