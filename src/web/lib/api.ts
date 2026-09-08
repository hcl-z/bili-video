import type { AppConfig, ConfigSection } from '#shared/contract/config.ts'
import type {
  ConfigResponse,
  ErrorResponse,
  HealthResponse,
  PatchSubscriptionRequest,
  PollResult,
  RulesResponse,
  SubscriptionResult,
  SubscriptionsResponse,
  SystemResponse,
  TestRulesResponse,
  UpdatesResponse,
} from '#shared/contract/api.ts'
import type { RuleKind } from '#shared/contract/subscription.ts'

/**
 * 数据层：所有请求走这一个函数，因此「怎么报错」只有一种写法。
 *
 * 后端只听 127.0.0.1，没有登录系统（spec Q31a），所以这里没有 token、没有 401 处理。
 * dev 下 /api 由 Vite 代理到 8788；打包后前端由后端自己伺服，同源。
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  })

  if (!res.ok) {
    // 后端所有错误都是 { error: { code, message } }；解不出来才退回状态码文本。
    let code = 'unknown'
    let message = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as ErrorResponse
      code = body.error.code
      message = body.error.message
    } catch {
      // 非 JSON 响应（比如代理没起来时的 HTML），保留状态码文本。
    }
    throw new ApiError(res.status, code, message)
  }

  return (await res.json()) as T
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  config: () => request<ConfigResponse>('/config'),

  // PATCH 回的是**整份**配置（和 GET 同一个 body），不是被改的那一段 ——
  // 于是页面拿到的永远是服务端认过的全量真相，不需要自己合并。
  patchConfig: <S extends ConfigSection>(section: S, patch: Partial<AppConfig[S]>) =>
    request<ConfigResponse>(`/config/${section}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  system: () => request<SystemResponse>('/system'),

  subs: () => request<SubscriptionsResponse>('/subscriptions'),

  // input 是用户粘进来的原文（uid / 链接 / 一整段分享文本），uid 的识别在后端。
  addSub: (input: string) =>
    request<SubscriptionResult>('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ input }),
    }),

  patchSub: (uid: string, patch: PatchSubscriptionRequest) =>
    request<SubscriptionResult>(`/subscriptions/${uid}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  removeSub: (uid: string) =>
    request<SubscriptionsResponse>(`/subscriptions/${uid}`, { method: 'DELETE' }),

  followSub: (uid: string) =>
    request<SubscriptionResult>(`/subscriptions/${uid}/follow`, { method: 'POST' }),

  // 被过滤的条目默认也要（灰显），filtered=0 才只看通过的。
  updates: (opts: { includeFiltered?: boolean } = {}) =>
    request<UpdatesResponse>(`/updates${opts.includeFiltered === false ? '?filtered=0' : ''}`),

  pollNow: () => request<PollResult>('/updates/poll', { method: 'POST' }),

  rules: () => request<RulesResponse>('/rules'),

  addRule: (rule: { scope: string; kind: RuleKind; pattern: string }) =>
    request<RulesResponse>('/rules', { method: 'POST', body: JSON.stringify(rule) }),

  patchRule: (id: number, enabled: boolean) =>
    request<RulesResponse>(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),

  removeRule: (id: number) => request<RulesResponse>(`/rules/${id}`, { method: 'DELETE' }),

  testRules: (input: { sample: string; uid: string | null }) =>
    request<TestRulesResponse>('/rules/test', { method: 'POST', body: JSON.stringify(input) }),
}
