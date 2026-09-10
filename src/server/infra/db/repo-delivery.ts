import type { DatabaseSync } from 'node:sqlite'

import type { VideoUsage } from '#shared/contract/api.ts'
import type { DeliveryKind, DeliveryStatus } from '#shared/contract/job.ts'
import type { DeliveryRecord, DeliveryRepo, LlmCallRepo } from '../../types/persistence.ts'
import type { NotifyChannel } from '../../types/delivery.ts'
import { num, str, strOrNull, type Row } from './sqlite.ts'

const toDelivery = (r: Row): DeliveryRecord => ({
  id: num(r['id']),
  updateId: str(r['update_id']),
  channel: str(r['channel']) as NotifyChannel,
  kind: str(r['kind']) as DeliveryKind,
  status: str(r['status']) as DeliveryStatus,
  attempts: num(r['attempts']),
  error: strOrNull(r['err']),
  at: num(r['at']),
})

export class SqliteDeliveryRepo implements DeliveryRepo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** 去重机制就是应项唯一索引本身，不是应用层的「先查再插」（那中间有窗口）。 返回 false = 应项 (update, channel, kind) 已经投过或正在投，调用方直接不发。 已经 failed 的允许重新占用，否则一次网络抖动就永久拉黑应项投递 */
  claim(d: {
    updateId: string
    channel: NotifyChannel
    kind: DeliveryKind
    at: number
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO deliveries (update_id, channel, kind, status, attempts, err, at)
         VALUES (?, ?, ?, 'pending', 1, NULL, ?)
         ON CONFLICT(update_id, channel, kind) DO UPDATE SET
           status = 'pending', attempts = deliveries.attempts + 1, at = excluded.at
         WHERE deliveries.status = 'failed'`,
      )
      .run(d.updateId, d.channel, d.kind, d.at)
    return Number(info.changes) > 0
  }

  settle(
    d: { updateId: string; channel: NotifyChannel; kind: DeliveryKind },
    outcome: { status: DeliveryStatus; error: string | null },
    at: number,
  ): void {
    this.db
      .prepare(
        `UPDATE deliveries SET status = ?, err = ?, at = ?
          WHERE update_id = ? AND channel = ? AND kind = ?`,
      )
      .run(outcome.status, outcome.error, at, d.updateId, d.channel, d.kind)
  }

  listForUpdate(updateId: string): DeliveryRecord[] {
    return this.db
      .prepare('SELECT * FROM deliveries WHERE update_id = ? ORDER BY id')
      .all(updateId)
      .map((r) => toDelivery(r as Row))
  }

  retryable(limit: number): DeliveryRecord[] {
    return this.db
      .prepare("SELECT * FROM deliveries WHERE status IN ('pending', 'failed') ORDER BY at, id LIMIT ?")
      .all(limit)
      .map((r) => toDelivery(r as Row))
  }

  recent(limit: number): DeliveryRecord[] {
    return this.db
      .prepare('SELECT * FROM deliveries ORDER BY at DESC LIMIT ?')
      .all(limit)
      .map((r) => toDelivery(r as Row))
  }
}

export class SqliteLlmCallRepo implements LlmCallRepo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  record(call: {
    bvid: string | null
    stage: string
    model: string
    inTokens: number
    outTokens: number
    ms: number
    at: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO llm_calls (bvid, stage, model, in_tokens, out_tokens, ms, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(call.bvid, call.stage, call.model, call.inTokens, call.outTokens, call.ms, call.at)
  }

  usageSince(ts: number): { calls: number; inTokens: number; outTokens: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens
           FROM llm_calls WHERE at >= ?`,
      )
      .get(ts) as Row | undefined
    if (!r) return { calls: 0, inTokens: 0, outTokens: 0 }
    return {
      calls: num(r['calls']),
      inTokens: num(r['in_tokens']),
      outTokens: num(r['out_tokens']),
    }
  }

  usageForVideo(bvid: string): VideoUsage {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens,
                COALESCE(SUM(ms), 0) AS ms
           FROM llm_calls WHERE bvid = ?`,
      )
      .get(bvid) as Row | undefined
    if (!r) return { calls: 0, inTokens: 0, outTokens: 0, ms: 0 }
    return {
      calls: num(r['calls']),
      inTokens: num(r['in_tokens']),
      outTokens: num(r['out_tokens']),
      ms: num(r['ms']),
    }
  }
}
