import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import type { PipelineStep } from '#shared/contract/job.ts'
import { JOB_STAGE_LABEL } from '#shared/contract/job.ts'
import { api } from '@/lib/api'
import { keys } from '@/lib/query'

/**
 * 队列页和阅读栏共用：重跑一条任务，两处的列表都要跟着变。
 *
 * 传 from 就是「从这一步重跑」，它之前的产物照用；不传是从头来一遍。
 */
export function useRetryJob(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (opts: { from?: PipelineStep } = {}) => api.retryJob(id, opts.from),
    onSuccess: (_job, opts) => {
      void qc.invalidateQueries({ queryKey: keys.jobs })
      void qc.invalidateQueries({ queryKey: keys.summaries })
      const from = opts?.from
      toast.success(
        from === undefined ? '已重新排上队' : `已从「${JOB_STAGE_LABEL[from]}」重新排上队`,
        from === undefined ? undefined : { description: '前面几步的结果直接复用，不再重跑' },
      )
    },
    onError: (err: Error) => toast.error('重跑没成', { description: err.message }),
  })
}
