import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { keys } from '@/lib/query'

/** 没进过队列的视频：手动排一条。 */
export function useRunSummary(bvid: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.runSummary(bvid),
    onSuccess: () => {
      invalidate(qc)
      toast.success('已排上队')
    },
    onError: (err: Error) => toast.error('没排上队', { description: err.message }),
  })
}

/** 索引里攒了一堆没总结的：一次全补上。 */
export function useRunAllSummaries() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.runAllSummaries,
    onSuccess: (res) => {
      invalidate(qc)
      if (res.queued === 0) toast.info('没有需要补的，都已经总结过或在队列里了')
      else toast.success(`已排上队 ${res.queued} 条`, { description: '去「队列」页看阶段' })
    },
    onError: (err: Error) => toast.error('没排上队', { description: err.message }),
  })
}

function invalidate(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: keys.jobs })
  void qc.invalidateQueries({ queryKey: keys.summaries })
}
