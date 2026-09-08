import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { keys } from '@/lib/query'

/** 队列页和阅读栏共用：重跑一条任务，两处的列表都要跟着变。 */
export function useRetryJob(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.retryJob(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.jobs })
      void qc.invalidateQueries({ queryKey: keys.summaries })
      toast.success('已重新排上队')
    },
    onError: (err: Error) => toast.error('重跑没成', { description: err.message }),
  })
}
