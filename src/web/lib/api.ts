import type { AppConfig, ConfigSection } from '#shared/contract/config.ts'
import type {
  AiSettingsResponse,
  AiTestResponse,
  ConfigResponse,
  ErrorResponse,
  HealthResponse,
  HealthSnapshot,
  JobsResponse,
  LoginStartResponse,
  NotifySettingsResponse,
  NotifyTestResponse,
  OverviewResponse,
  PatchAiSettingsRequest,
  PatchNotifySettingsRequest,
  PatchSubscriptionRequest,
  PollResult,
  QrResponse,
  ReaderItemResponse,
  RefreshResponse,
  RulesResponse,
  RunAllSummariesResponse,
  StorageResponse,
  SubscriptionResult,
  SubscriptionsResponse,
  SummariesResponse,
  SummaryDetailResponse,
  TranscriptResponse,
  SystemResponse,
  TestRulesResponse,
  UpdatesResponse,
  UpFeedResponse,
} from '#shared/contract/api.ts'
import type { PipelineStep, SummaryJob } from '#shared/contract/job.ts'
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

  /** 概览页一次要齐的东西。全是本地读，刷它不会打任何外部请求。 */
  overview: () => request<OverviewResponse>('/overview'),

  /** 手动跑一轮健康自查。cron 半小时一次，等不及的时候点它。 */
  checkHealth: () => request<HealthSnapshot>('/overview/check', { method: 'POST' }),

  // 开一轮扫码。不等人扫完：返回时码可能还没出来，靠 SSE 的登录态变化再来取。
  startLogin: () => request<LoginStartResponse>('/system/login', { method: 'POST' }),

  /** 当前那张待扫的码。没有码在等人扫时后端回 404。 */
  qr: () => request<QrResponse>('/system/qr'),

  refreshCookie: () => request<RefreshResponse>('/system/refresh', { method: 'POST' }),

  storage: () => request<StorageResponse>('/system/storage'),

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

  /** 单条动态。阅读页深链接进来、左栏还没翻到那一页时用。 */
  readerItem: (dynId: string) => request<ReaderItemResponse>(`/updates/${dynId}`),

  rules: () => request<RulesResponse>('/rules'),

  addRule: (rule: { scope: string; kind: RuleKind; pattern: string }) =>
    request<RulesResponse>('/rules', { method: 'POST', body: JSON.stringify(rule) }),

  patchRule: (id: number, enabled: boolean) =>
    request<RulesResponse>(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),

  removeRule: (id: number) => request<RulesResponse>(`/rules/${id}`, { method: 'DELETE' }),

  testRules: (input: { sample: string; uid: string | null }) =>
    request<TestRulesResponse>('/rules/test', { method: 'POST', body: JSON.stringify(input) }),

  // 索引按 pubTs 游标翻页（before = 上一页最后一条），阅读栏点一条拉一条。
  summaries: (before?: number) =>
    request<SummariesResponse>(`/summaries${before === undefined ? '' : `?before=${before}`}`),

  /** 某个 UP 的空间流。**每页都是一次出网请求**，别拿它做预取。 */
  upFeed: (uid: string, offset?: string) =>
    request<UpFeedResponse>(
      `/ups/${uid}/feed${offset === undefined ? '' : `?offset=${encodeURIComponent(offset)}`}`,
    ),

  /** 手动排一条解析。轮询只抓启动后新发的，历史投稿靠这个。 */
  parseUpItem: (uid: string, dynId: string) =>
    request<SummaryJob>(`/ups/${uid}/items/${dynId}/parse`, { method: 'POST' }),

  summary: (bvid: string) => request<SummaryDetailResponse>(`/summaries/${bvid}`),

  /** 完整字幕/转写全文。点开才拉，可能有几万字。 */
  transcript: (bvid: string) => request<TranscriptResponse>(`/summaries/${bvid}/transcript`),

  /** 手动把一条视频排上队。轮询只管新抓到的，旧的靠这个补。 */
  runSummary: (bvid: string) => request<SummaryJob>(`/summaries/${bvid}/run`, { method: 'POST' }),

  runAllSummaries: () =>
    request<RunAllSummariesResponse>('/summaries/run-all', { method: 'POST' }),

  jobs: () => request<JobsResponse>('/jobs'),

  // from = 从哪一步起跑，它之前的产物照用；不传是从头。
  retryJob: (id: number, from?: PipelineStep) =>
    request<SummaryJob>(`/jobs/${id}/retry${from === undefined ? '' : `?from=${from}`}`, {
      method: 'POST',
    }),

  aiSettings: () => request<AiSettingsResponse>('/ai'),

  // apiKey 留空表示不修改。表单只写不读，所以「没动过」和「空」是同一件事。
  patchAiSettings: (patch: PatchAiSettingsRequest) =>
    request<AiSettingsResponse>('/ai', { method: 'PATCH', body: JSON.stringify(patch) }),

  testAi: () => request<AiTestResponse>('/ai/test', { method: 'POST' }),

  notifySettings: () => request<NotifySettingsResponse>('/notify'),

  patchNotifySettings: (patch: PatchNotifySettingsRequest) =>
    request<NotifySettingsResponse>('/notify', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  testNotify: (channel: 'wxpusher' | 'pushplus' | 'ntfy' | 'feishu' | 'webhook') =>
    request<NotifyTestResponse>(`/notify/${channel}/test`, { method: 'POST' }),
}
