import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import type { ReaderItem } from '#shared/contract/api.ts'
import { api } from '@/lib/api'
import { keys } from '@/lib/query'
import { patchUpFeedItem } from '@/lib/reader-cache'

/**
 * 手动排一条解析（含重跑）。
 *
 * 一律走 `/ups/.../parse`：它会先把动态落库（不落库的总结拿不到标题和简介），
 * 而且不判过滤规则 —— 规则拦的是自动解析，手动点就是明确要它。
 */
export function useParseItem(item: ReaderItem) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => {
      if (item.bvid === null) throw new Error('这条不是视频')
      return api.parseUpItem(item.uid, item.dynId)
    },
    onSuccess: (job) => {
      patchUpFeedItem(qc, job.bvid, { state: 'pending', jobStage: 'queued', inDb: true })
      void qc.invalidateQueries({ queryKey: keys.jobs })
      void qc.invalidateQueries({ queryKey: keys.summaries })
      toast.success('已排上队', { description: '解析完这里会多出一个「解析信息」的标签页' })
    },
    onError: (err: Error) => toast.error('没排上队', { description: err.message }),
  })
}
