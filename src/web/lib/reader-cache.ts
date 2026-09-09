import type { InfiniteData, QueryClient } from '@tanstack/react-query'

import type { ReaderItem, UpFeedResponse } from '#shared/contract/api.ts'
import { keys } from './query'

/**
 * 就地改缓存里那一行的状态，不重取。
 *
 * 空间流的每一页都是一次出网请求，对无限查询做 invalidate 等于把翻过的页
 * 全部重新打一遍 B 站 —— 状态变化这点信息不值这个代价。
 */
export function patchUpFeedItem(
  qc: QueryClient,
  bvid: string,
  patch: Partial<ReaderItem>,
): void {
  qc.setQueriesData<InfiniteData<UpFeedResponse>>({ queryKey: keys.upFeed }, (data) =>
    data === undefined
      ? data
      : {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((i) => (i.bvid === bvid ? { ...i, ...patch } : i)),
          })),
        },
  )
}
