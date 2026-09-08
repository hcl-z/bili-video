import { Hono } from 'hono'

import type { JobsResponse } from '#shared/contract/api.ts'
import type { SummaryQueue } from '../../app/queue-runner.ts'
import { videoRef } from '../../domain/summary-format.ts'
import type { Ports } from '../../ports/index.ts'
import { errorBody } from '../errors.ts'

/** 队列页要的两件事：现在都有哪些任务，以及「再跑一次」。 */
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

    .post('/:id/retry', (c) => {
      const id = Number(c.req.param('id'))
      if (!Number.isInteger(id)) return c.json(errorBody('invalid-request', '任务 id 不对'), 400)

      const res = queue.retry(id)
      if (res === 'missing') return c.json(errorBody('not-found', '没有这条任务'), 404)
      if (res === 'busy') return c.json(errorBody('conflict', '这条任务正在队列里，不用重跑'), 409)

      const job = ports.repos.jobs.get(id)
      if (job === null) return c.json(errorBody('not-found', '没有这条任务'), 404)
      return c.json(job)
    })
}
