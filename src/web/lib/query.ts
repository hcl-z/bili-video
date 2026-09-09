import { QueryClient } from '@tanstack/react-query'

import { ApiError } from './api'

/**
 * 单用户、本地服务：没有网络抖动，也没有多端并发。
 * 所以关掉窗口聚焦重取（每次切回浏览器都打一串请求太吵），只在明确失效时重取。
 * 真正需要「实时」的地方走 SSE（/events），不靠轮询。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => {
        // 4xx 是我们自己传错了参数，重试多少次都一样。
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
  /** 磁盘占用。要 stat 文件，所以不跟着 SSE 失效，进系统页时取一次。 */
  storage: ['storage'] as const,
  qr: ['qr'] as const,
  subs: ['subs'] as const,
  updates: ['updates'] as const,
  rules: ['rules'] as const,
  ai: ['ai'] as const,
  notify: ['notify'] as const,
  jobs: ['jobs'] as const,
  summaries: ['summaries'] as const,
  /** 空间流。**不挂 SSE** —— 对无限查询做失效会把已加载的每一页都重新打一次 B 站。 */
  upFeed: ['up-feed'] as const,
}
