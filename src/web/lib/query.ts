import { QueryClient } from '@tanstack/react-query'

import { ApiError } from './api'

/** 单用户本地服务无需处理网络抖动或多端并发。 禁用窗口聚焦重取，仅在明确失效时刷新；实时数据通过 SSE（/events）更新，不轮询 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => {
        // 4xx 是我们自己传错了参数，重试多少次都一样
        if (err instanceof ApiError && err.status < 500) return false
        return count < 2
      },
    },
  },
})

export const keys = {
  health: ['health'] as const,
  config: ['config'] as const,
  system: ['system'] as const,
  overview: ['overview'] as const,
  /** 磁盘占用。要 stat 文件，所以不跟着 SSE 失效，进系统页时取一次 */
  storage: ['storage'] as const,
  qr: ['qr'] as const,
  subs: ['subs'] as const,
  updates: ['updates'] as const,
  rules: ['rules'] as const,
  ai: ['ai'] as const,
  notify: ['notify'] as const,
  prompts: ['prompts'] as const,
  jobs: ['jobs'] as const,
  summaries: ['summaries'] as const,
  /** 空间流。**不挂 SSE** —— 对无限查询做失效会把已加载的每一页都重新打一次 B 站 */
  upFeed: ['up-feed'] as const,
}
