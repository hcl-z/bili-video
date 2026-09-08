import type { DatabaseSync } from 'node:sqlite'

import type { JobStage, JobStatus, SummaryJob } from '#shared/contract/job.ts'
import type { DegradePath, Summary, TranscriptSource } from '#shared/contract/summary.ts'
import { ChapterSchema, KeyInfoSchema } from '#shared/contract/summary.ts'
import type { JobRepo, SummaryRepo } from '../../ports/repo.ts'
import { num, str, strOrNull, type Row } from './sqlite.ts'

const toJob = (r: Row): SummaryJob => ({
  id: num(r['id']),
  bvid: str(r['bvid']),
  updateId: str(r['update_id']),
  status: str(r['status']) as JobStatus,
  stage: str(r['stage']) as JobStage,
  attempts: num(r['attempts']),
  error: strOrNull(r['error']),
  createdAt: num(r['created_at']),
  updatedAt: num(r['updated_at']),
})

export class SqliteJobRepo implements JobRepo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** 一个 bvid 一条任务。重复入队 = 复位这一行重跑，不是插第二条。 */
  enqueue(job: { bvid: string; updateId: string; at: number }): SummaryJob {
    this.db
      .prepare(
        `INSERT INTO summary_jobs (bvid, update_id, status, stage, attempts, error, created_at, updated_at)
         VALUES (?, ?, 'pending', 'queued', 0, NULL, ?, ?)
         ON CONFLICT(bvid) DO UPDATE SET
           status = 'pending', stage = 'queued', error = NULL, updated_at = excluded.updated_at`,
      )
      .run(job.bvid, job.updateId, job.at, job.at)
    const created = this.getByBvid(job.bvid)
    if (created === null) throw new Error(`enqueue failed for ${job.bvid}`)
    return created
  }

  get(id: number): SummaryJob | null {
    const r = this.db.prepare('SELECT * FROM summary_jobs WHERE id = ?').get(id)
    return r ? toJob(r as Row) : null
  }

  getByBvid(bvid: string): SummaryJob | null {
    const r = this.db.prepare('SELECT * FROM summary_jobs WHERE bvid = ?').get(bvid)
    return r ? toJob(r as Row) : null
  }

  /**
   * 取一条 pending 并原子置为 running。node:sqlite 是同步的、进程内单线程，
   * 一条 UPDATE ... WHERE id = (SELECT ...) 就够，不需要 SKIP LOCKED 那套。
   */
  claimNext(at: number): SummaryJob | null {
    const r = this.db
      .prepare(
        `UPDATE summary_jobs
            SET status = 'running', attempts = attempts + 1, updated_at = ?
          WHERE id = (SELECT id FROM summary_jobs WHERE status = 'pending' ORDER BY id LIMIT 1)
          RETURNING *`,
      )
      .get(at)
    return r ? toJob(r as Row) : null
  }

  setStage(id: number, stage: JobStage, at: number): void {
    this.db
      .prepare('UPDATE summary_jobs SET stage = ?, updated_at = ? WHERE id = ?')
      .run(stage, at, id)
  }

  finish(id: number, outcome: { ok: true } | { ok: false; error: string }, at: number): void {
    if (outcome.ok) {
      this.db
        .prepare(
          `UPDATE summary_jobs SET status = 'done', stage = 'persist', error = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(at, id)
    } else {
      this.db
        .prepare(`UPDATE summary_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .run(outcome.error, at, id)
    }
  }

  /** 启动时把崩在中途的 running 重置为 pending 续跑，返回复位了几条。 */
  resetRunning(at: number): number {
    const info = this.db
      .prepare(
        `UPDATE summary_jobs SET status = 'pending', stage = 'queued', updated_at = ? WHERE status = 'running'`,
      )
      .run(at)
    return Number(info.changes)
  }

  list(q: { status?: JobStatus; limit: number }): SummaryJob[] {
    const rows =
      q.status === undefined
        ? this.db.prepare('SELECT * FROM summary_jobs ORDER BY id DESC LIMIT ?').all(q.limit)
        : this.db
            .prepare('SELECT * FROM summary_jobs WHERE status = ? ORDER BY id DESC LIMIT ?')
            .all(q.status, q.limit)
    return rows.map((r) => toJob(r as Row))
  }
}

const toSummary = (r: Row): Summary => ({
  bvid: str(r['bvid']),
  tldr: str(r['tldr']),
  points: JSON.parse(str(r['points_json'])) as string[],
  overview: str(r['overview']),
  keyInfo: KeyInfoSchema.parse(JSON.parse(str(r['key_info_json'] ?? '{}'))),
  chapters: ChapterSchema.array().parse(JSON.parse(str(r['chapters_json']))),
  fullMd: str(r['full_md']),
  transcriptSource: str(r['transcript_source']) as TranscriptSource,
  degradePath: str(r['degrade_path']) as DegradePath,
  confidence: str(r['confidence']) as Summary['confidence'],
  createdAt: num(r['created_at']),
})

export class SqliteSummaryRepo implements SummaryRepo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  get(bvid: string): Summary | null {
    const r = this.db.prepare('SELECT * FROM summaries WHERE bvid = ?').get(bvid)
    return r ? toSummary(r as Row) : null
  }

  transcript(bvid: string): string | null {
    const r = this.db.prepare('SELECT transcript FROM summaries WHERE bvid = ?').get(bvid) as
      | Row
      | undefined
    const text = r?.['transcript']
    return typeof text === 'string' && text !== '' ? text : null
  }

  /** 重跑覆盖同一行，所以「任务可重跑无副作用」成立。 */
  upsert(s: Summary, transcript?: string | null): void {
    this.db
      .prepare(
        `INSERT INTO summaries
           (bvid, tldr, points_json, overview, key_info_json, chapters_json, full_md,
            transcript, transcript_source, confidence, degrade_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bvid) DO UPDATE SET
           tldr = excluded.tldr, points_json = excluded.points_json,
           overview = excluded.overview, key_info_json = excluded.key_info_json,
           chapters_json = excluded.chapters_json, full_md = excluded.full_md,
           transcript = excluded.transcript, transcript_source = excluded.transcript_source,
           confidence = excluded.confidence, degrade_path = excluded.degrade_path,
           created_at = excluded.created_at`,
      )
      .run(
        s.bvid,
        s.tldr,
        JSON.stringify(s.points),
        s.overview,
        JSON.stringify(s.keyInfo),
        JSON.stringify(s.chapters),
        s.fullMd,
        transcript ?? null,
        s.transcriptSource,
        s.confidence,
        s.degradePath,
        s.createdAt,
      )
  }

  list(q: { limit: number; before?: number }): Summary[] {
    const rows =
      q.before === undefined
        ? this.db.prepare('SELECT * FROM summaries ORDER BY created_at DESC LIMIT ?').all(q.limit)
        : this.db
            .prepare(
              'SELECT * FROM summaries WHERE created_at < ? ORDER BY created_at DESC LIMIT ?',
            )
            .all(q.before, q.limit)
    return rows.map((r) => toSummary(r as Row))
  }
}
