import type { DatabaseSync } from 'node:sqlite'

import type {
  JobStage,
  JobStatus,
  JobStep,
  PipelineStep,
  StepStatus,
  SummaryJob,
} from '#shared/contract/job.ts'
import type { DegradePath, Summary, TranscriptSource } from '#shared/contract/summary.ts'
import type { ArtifactKind } from '../../domain/pipeline.ts'
import { atOrAfter, stepIndex } from '../../domain/pipeline.ts'
import type {
  JobArtifact,
  JobArtifactRepo,
  JobRepo,
  JobStepOutcome,
  SummaryRepo,
} from '../../types/persistence.ts'
import { num, str, strOrNull, type Row } from './sqlite.ts'

const toStep = (r: Row): JobStep => ({
  step: str(r['step']) as PipelineStep,
  status: str(r['status']) as StepStatus,
  note: strOrNull(r['note']),
  at: num(r['at']),
})

export class SqliteJobRepo implements JobRepo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** 一个 bvid 单条任务。重复入队 = 复位这一行重跑，不是插第二条 */
  enqueue(job: {
    bvid: string
    updateId: string
    at: number
    from?: PipelineStep | null
  }): SummaryJob {
    const from = job.from ?? null
    this.db
      .prepare(
        `INSERT INTO summary_jobs
           (bvid, update_id, status, stage, attempts, error, resume_from, created_at, updated_at)
         VALUES (?, ?, 'pending', 'queued', 0, NULL, ?, ?, ?)
         ON CONFLICT(bvid) DO UPDATE SET
           status = 'pending', stage = 'queued', error = NULL,
           resume_from = excluded.resume_from, updated_at = excluded.updated_at`,
      )
      .run(job.bvid, job.updateId, from, job.at, job.at)
    const created = this.getByBvid(job.bvid)
    if (created === null) throw new Error(`enqueue failed for ${job.bvid}`)
    return created
  }

  get(id: number): SummaryJob | null {
    const r = this.db.prepare('SELECT * FROM summary_jobs WHERE id = ?').get(id)
    return r ? this.hydrate(r as Row) : null
  }

  getByBvid(bvid: string): SummaryJob | null {
    const r = this.db.prepare('SELECT * FROM summary_jobs WHERE bvid = ?').get(bvid)
    return r ? this.hydrate(r as Row) : null
  }

  setStep(
    jobId: number,
    step: PipelineStep,
    status: StepStatus,
    note: string | null,
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO job_steps (job_id, step, status, note, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(job_id, step) DO UPDATE SET
           status = excluded.status, note = excluded.note, at = excluded.at`,
      )
      .run(jobId, step, status, note, at)
  }

  /** 只复位 from 及其之后的几步：前面那几步的状态是「这次没重跑」的证据。 */
  resetStepsFrom(jobId: number, from: PipelineStep, at: number): void {
    const rows = this.db.prepare('SELECT step FROM job_steps WHERE job_id = ?').all(jobId)
    for (const r of rows) {
      const step = str((r as Row)['step']) as PipelineStep
      if (atOrAfter(step, from)) this.setStep(jobId, step, 'pending', null, at)
    }
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
    return r ? this.hydrate(r as Row) : null
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
    if (rows.length === 0) return []

    // 一次把这批任务的步骤全取回来，别一行一个查询。
    const steps = new Map<number, JobStep[]>()
    const ids = rows.map((r) => num((r as Row)['id']))
    const placeholders = ids.map(() => '?').join(',')
    for (const r of this.db
      .prepare(`SELECT * FROM job_steps WHERE job_id IN (${placeholders})`)
      .all(...ids)) {
      const jobId = num((r as Row)['job_id'])
      const list = steps.get(jobId) ?? []
      list.push(toStep(r as Row))
      steps.set(jobId, list)
    }
    return rows.map((r) => toJob(r as Row, steps.get(num((r as Row)['id'])) ?? []))
  }

  counts(): Record<JobStatus, number> {
    const out: Record<JobStatus, number> = { pending: 0, running: 0, failed: 0, done: 0 }
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM summary_jobs GROUP BY status').all()) {
      const status = str((r as Row)['status']) as JobStatus
      if (status in out) out[status] = num((r as Row)['n'])
    }
    return out
  }

  runningStages(): JobStage[] {
    return this.db
      .prepare(`SELECT stage FROM summary_jobs WHERE status = 'running'`)
      .all()
      .map((r) => str((r as Row)['stage']) as JobStage)
  }

  /** 只回真跑过的：skipped（有字幕、没接适配器）不是一次失败，不该把连败计数清掉。 */
  recentSteps(step: PipelineStep, limit: number): JobStepOutcome[] {
    return this.db
      .prepare(
        `SELECT status, note, at FROM job_steps
          WHERE step = ? AND status IN ('done', 'failed')
          ORDER BY at DESC, job_id DESC LIMIT ?`,
      )
      .all(step, limit)
      .map((r) => ({
        status: str((r as Row)['status']) as StepStatus,
        note: strOrNull((r as Row)['note']),
        at: num((r as Row)['at']),
      }))
  }

  private hydrate(r: Row): SummaryJob {
    const id = num(r['id'])
    const steps = this.db
      .prepare('SELECT * FROM job_steps WHERE job_id = ?')
      .all(id)
      .map((s) => toStep(s as Row))
    return toJob(r, steps)
  }
}

/** 步骤按流水线顺序排，页面直接铺开就是一排圆点。 */
const toJob = (r: Row, steps: JobStep[]): SummaryJob => ({
  id: num(r['id']),
  bvid: str(r['bvid']),
  updateId: str(r['update_id']),
  status: str(r['status']) as JobStatus,
  stage: str(r['stage']) as JobStage,
  attempts: num(r['attempts']),
  error: strOrNull(r['error']),
  resumeFrom: strOrNull(r['resume_from']) as PipelineStep | null,
  steps: steps.sort((a, b) => stepIndex(a.step) - stepIndex(b.step)),
  createdAt: num(r['created_at']),
  updatedAt: num(r['updated_at']),
})

export class SqliteJobArtifactRepo implements JobArtifactRepo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  get(bvid: string, kind: ArtifactKind): JobArtifact | null {
    const r = this.db
      .prepare('SELECT payload, meta_json, at FROM job_artifacts WHERE bvid = ? AND kind = ?')
      .get(bvid, kind) as Row | undefined
    if (r === undefined) return null
    const meta = strOrNull(r['meta_json'])
    return {
      payload: str(r['payload']),
      meta: meta === null ? null : (JSON.parse(meta) as unknown),
      at: num(r['at']),
    }
  }

  put(bvid: string, kind: ArtifactKind, a: { payload: string; meta?: unknown; at: number }): void {
    this.db
      .prepare(
        `INSERT INTO job_artifacts (bvid, kind, payload, meta_json, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bvid, kind) DO UPDATE SET
           payload = excluded.payload, meta_json = excluded.meta_json, at = excluded.at`,
      )
      .run(bvid, kind, a.payload, a.meta === undefined ? null : JSON.stringify(a.meta), a.at)
  }

  drop(bvid: string, kinds: readonly ArtifactKind[]): void {
    if (kinds.length === 0) return
    const placeholders = kinds.map(() => '?').join(',')
    this.db
      .prepare(`DELETE FROM job_artifacts WHERE bvid = ? AND kind IN (${placeholders})`)
      .run(bvid, ...kinds)
  }
}

const toSummary = (r: Row): Summary => {
  const fullMd = str(r['full_md'])
  const article = strOrNull(r['article']) ?? ''
  return {
    bvid: str(r['bvid']),
    tldr: str(r['tldr']),
    // 老数据没有 article（那会儿存的是结构化字段），退回落盘的那份全文。
    article: article === '' ? fullMd : article,
    fullMd,
    transcriptSource: str(r['transcript_source']) as TranscriptSource,
    degradePath: str(r['degrade_path']) as DegradePath,
    confidence: str(r['confidence']) as Summary['confidence'],
    createdAt: num(r['created_at']),
  }
}

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

  /**
   * 重跑覆盖同一行，所以「任务可重跑无副作用」成立。
   *
   * points_json / chapters_json / key_info_json 是老口径的列，NOT NULL 且不再产出，
   * 所以写空值占位 —— 迁移只追加不改，删列的代价大于留三个空字段。
   */
  upsert(s: Summary, transcript?: string | null): void {
    this.db
      .prepare(
        `INSERT INTO summaries
           (bvid, tldr, article, points_json, overview, key_info_json, chapters_json, full_md,
            transcript, transcript_source, confidence, degrade_path, created_at)
         VALUES (?, ?, ?, '[]', '', '{}', '[]', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bvid) DO UPDATE SET
           tldr = excluded.tldr, article = excluded.article, full_md = excluded.full_md,
           transcript = excluded.transcript, transcript_source = excluded.transcript_source,
           confidence = excluded.confidence, degrade_path = excluded.degrade_path,
           created_at = excluded.created_at`,
      )
      .run(
        s.bvid,
        s.tldr,
        s.article,
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

  count(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM summaries').get()
    return r ? num((r as Row)['n']) : 0
  }
}
