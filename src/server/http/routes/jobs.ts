import { Hono } from 'hono'

import type { JobsResponse } from '#shared/contract/api.ts'
import { PipelineStepSchema } from '#shared/contract/job.ts'
import type { SummaryQueue } from '../../app/queue-runner.ts'
import { videoRef } from '../../domain/summary-format.ts'
import type { Ports } from '../../ports/index.ts'
import { errorBody } from '../errors.ts'

export function jobRoutes(ports: Ports, queue: SummaryQueue): Hono {
  return new Hono()
    .get('/', (c) => {
      const jobs = ports.repos.jobs.list({ limit: 200 })
      const body: JobsResponse = { jobs, videos: {} }
      for (const job of jobs) {
        body.videos[job.bvid] = videoRef(job.bvid, ports.repos.updates.get(job.updateId) ?? null)
      }
      return c.json(body)
    })

    /**
     * 重跑。`?from=<step>` 指定从哪一步起跑：那一步之前的产物照用，不重复跑。
     * 不带 from 就是从头来一遍。
     */
    .post('/:id/retry', (c) => {
      const id = Number(c.req.param('id'))
      if (!Number.isInteger(id)) return c.json(errorBody('invalid-request', '任务 id 不对'), 400)

      const raw = c.req.query('from')
      const from = raw === undefined ? undefined : PipelineStepSchema.safeParse(raw)
      if (from !== undefined && !from.success) {
        return c.json(errorBody('invalid-request', `没有这一步：${raw}`), 400)
      }

      const res = queue.retry(id, from?.data)
      if (res === 'missing') return c.json(errorBody('not-found', '没有这条任务'), 404)
      if (res === 'busy') return c.json(errorBody('conflict', '这条任务正在队列里，不用重跑'), 409)

      const job = ports.repos.jobs.get(id)
      if (job === null) return c.json(errorBody('not-found', '没有这条任务'), 404)
      return c.json(job)
    })
}
