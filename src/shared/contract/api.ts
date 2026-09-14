import { z } from 'zod'
import {
  DEFAULT_PROMPT_TEMPLATE,
  PROMPT_VARIABLES,
  PromptTemplateSchema,
} from './prompt.ts'
import {
  AiConfigSchema,
  AppConfigSchema,
  AsrConfigSchema,
  AsrProviderSchema,
  DynamicKindConfigSchema,
  NotifyConfigSchema,
} from './config.ts'
import {
  DeliveryKindSchema,
  DeliveryStatusSchema,
  JobStageSchema,
  SummaryJobSchema,
} from './job.ts'
import { ProbeResultSchema } from './probe.ts'
import { DegradePathSchema, SummarySchema, TranscriptSourceSchema } from './summary.ts'
import {
  FilterRuleSchema,
  RuleKindSchema,
  RuleScopeSchema,
  SubscriptionSchema,
} from './subscription.ts'
import { DynamicTypeSchema, UpdateSchema } from './update.ts'

/** 每个 /api 端点的 req/res schema。前端从 z.infer 拿类型， 后端用同一个 schema 做入参校验 —— 契约不会前后端各写一份 */

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  /** 进程启动时刻（epoch ms），配 uptimeMs 一起看能判断有没有偷偷重启过 */
  startedAt: z.number().int(),
  uptimeMs: z.number().int().min(0),
  now: z.number().int(),
})
export type HealthResponse = z.infer<typeof HealthResponseSchema>

/** 登录态。五个状态互斥且穷举 —— 工作台上「转圈」不是一个状态， 「不知道」必须落到 logged-out 或 auth-lost 之一，否则页面会永远等下去 */
export const AuthStateSchema = z.enum([
  /** 本地没有 cookie，等人来扫码 */
  'logged-out',
  /** 二维码已打印，等扫 */
  'waiting-scan',

  'scanned',
  'logged-in',
  /** 有 cookie 但已经不能用了（续期链走不通或 B 站说没登录）。要人重新扫码 */
  'auth-lost',
])
export type AuthState = z.infer<typeof AuthStateSchema>

export const AUTH_STATE_LABEL: Record<AuthState, string> = {
  'logged-out': '未登录',
  'waiting-scan': '等待扫码',
  scanned: '已扫码，等确认',
  'logged-in': '已登录',
  'auth-lost': '登录已失效',
}

export const AuthSnapshotSchema = z.object({
  state: AuthStateSchema,
  uid: z.string().nullable(),
  uname: z.string().nullable(),
  /** cookie 到期时刻（epoch ms）；null = 无从判断 */
  expiresAt: z.number().int().nullable(),

  remainingMs: z.number().int().min(0).nullable(),
  /** 连续续期失败次数。工作台要能看见「已经失败几次了」 */
  refreshFailures: z.number().int().min(0),
  /** 上次核对登录态的时刻；null = 本进程还没核对过 */
  checkedAt: z.number().int().nullable(),

  lastError: z.string().nullable(),
  /** 当前那张待扫二维码的地址；null = 现在没有码在等人扫 */
  qrUrl: z.string().nullable(),
})
export type AuthSnapshot = z.infer<typeof AuthSnapshotSchema>

/** auth-lost 是终态：cron 已经被摘掉，页面看到它就应催人重新登录 */
export const PollStatusSchema = z.enum(['idle', 'running', 'backoff', 'disabled', 'auth-lost'])
export type PollStatus = z.infer<typeof PollStatusSchema>

export const POLL_STATUS_LABEL: Record<PollStatus, string> = {
  idle: '待下一轮',
  running: '正在拉取',
  backoff: '退避中',
  disabled: '已关闭',
  'auth-lost': '登录已失效',
}

export const PollSnapshotSchema = z.object({
  status: PollStatusSchema,
  lastRunAt: z.number().int().nullable(),
  lastOk: z.boolean().nullable(),
  lastError: z.string().nullable(),

  resumeAt: z.number().int().nullable(),
  consecutiveFailures: z.number().int().min(0),

  floorTs: z.number().int(),
})
export type PollSnapshot = z.infer<typeof PollSnapshotSchema>

export const SystemResponseSchema = z.object({
  auth: AuthSnapshotSchema,
  poll: PollSnapshotSchema,
  version: z.string(),
  startedAt: z.number().int(),
  uptimeMs: z.number().int().min(0),
  now: z.number().int(),
})
export type SystemResponse = z.infer<typeof SystemResponseSchema>

/** 待扫的二维码。svg 由服务端渲染 —— 前端不为单个二维码再引一个编码库 */
export const QrResponseSchema = z.object({ url: z.string(), svg: z.string() })
export type QrResponse = z.infer<typeof QrResponseSchema>

export const LoginStartResponseSchema = z.object({
  /** false = 已经有单个二维码在等人扫，这次没再出新的 */
  started: z.boolean(),
  auth: AuthSnapshotSchema,
})
export type LoginStartResponse = z.infer<typeof LoginStartResponseSchema>

/** 手动续期的结果。失败也是 200：这是「续期没成」，不是「这个请求错了」 */
export const RefreshResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  auth: AuthSnapshotSchema,
})
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>

/** 磁盘与条数。文件体积要 stat 磁盘，所以它不跟 /api/system 那份同步快照混在一起 */
export const StorageResponseSchema = z.object({
  /** 数据库文件本体 + WAL/SHM。分开列没意义，它们一起决定「库占了多大」 */
  dbBytes: z.number().int().min(0),
  audioBytes: z.number().int().min(0),
  markdownBytes: z.number().int().min(0),
  updates: z.number().int().min(0),
  summaries: z.number().int().min(0),

  audioDir: z.string(),
  markdownDir: z.string(),
})
export type StorageResponse = z.infer<typeof StorageResponseSchema>


export const FaultKindSchema = z.enum(['auth', 'poll', 'asr'])
export type FaultKind = z.infer<typeof FaultKindSchema>

export const FAULT_LABEL: Record<FaultKind, string> = {
  auth: '登录已失效',
  poll: '连续拉取失败',
  asr: '连续转写失败',
}

export const FaultSchema = z.object({
  kind: FaultKindSchema,

  message: z.string(),

  since: z.number().int(),
})
export type Fault = z.infer<typeof FaultSchema>

export const HealthSnapshotSchema = z.object({
  enabled: z.boolean(),
  cron: z.string(),
  /** 上一轮自查完成的时刻；null = 本进程还没查过 */
  lastCheckAt: z.number().int().nullable(),
  faults: z.array(FaultSchema),
})
export type HealthSnapshot = z.infer<typeof HealthSnapshotSchema>

/** 单条队列的积压。只有单条总结队列，两级并发是它内部的泳道 */
export const QueueSnapshotSchema = z.object({
  pending: z.number().int().min(0),
  running: z.number().int().min(0),
  failed: z.number().int().min(0),
  done: z.number().int().min(0),
  /** 在飞的任务分在哪条泳道：转写占 ASR 应项（并发 1），其余占 LLM 应项（并发 2） */
  inflight: z.object({
    asr: z.number().int().min(0),
    llm: z.number().int().min(0),
  }),
})
export type QueueSnapshot = z.infer<typeof QueueSnapshotSchema>

export const TokenUsageSchema = z.object({
  calls: z.number().int().min(0),
  inTokens: z.number().int().min(0),
  outTokens: z.number().int().min(0),
})
export type TokenUsage = z.infer<typeof TokenUsageSchema>

/** 推送时间轴上的单条。title/url 从对应的更新反查，告警没有更新可查就是 null */
export const DeliveryEntrySchema = z.object({
  updateId: z.string(),
  channel: z.string(),
  kind: DeliveryKindSchema,
  status: DeliveryStatusSchema,
  at: z.number().int(),
  error: z.string().nullable(),
  title: z.string().nullable(),
  url: z.string().nullable(),
})
export type DeliveryEntry = z.infer<typeof DeliveryEntrySchema>


export const OverviewResponseSchema = z.object({
  auth: AuthSnapshotSchema,
  poll: PollSnapshotSchema,
  queue: QueueSnapshotSchema,
  health: HealthSnapshotSchema,
  usage: z.object({ today: TokenUsageSchema, month: TokenUsageSchema }),
  deliveries: z.array(DeliveryEntrySchema),
  version: z.string(),
  startedAt: z.number().int(),
  uptimeMs: z.number().int().min(0),
  now: z.number().int(),
})
export type OverviewResponse = z.infer<typeof OverviewResponseSchema>

export const UpSearchItemSchema = z.object({
  uid: z.string(),
  name: z.string(),
  face: z.string().nullable(),
  signature: z.string(),
  fans: z.number().int().min(0),
})
export type UpSearchItem = z.infer<typeof UpSearchItemSchema>

export const UpSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(50),
})
export type UpSearchQuery = z.infer<typeof UpSearchQuerySchema>

export const UpSearchResponseSchema = z.object({
  items: z.array(UpSearchItemSchema),
})
export type UpSearchResponse = z.infer<typeof UpSearchResponseSchema>

export const SubscriptionsResponseSchema = z.object({
  subs: z.array(SubscriptionSchema),
})
export type SubscriptionsResponse = z.infer<typeof SubscriptionsResponseSchema>


export const AddSubscriptionRequestSchema = z.object({
  input: z.string().min(1),
})
export type AddSubscriptionRequest = z.infer<typeof AddSubscriptionRequestSchema>

/** 订阅成功但关注没成功是常态（写接口最容易撞风控），所以这两层分开回： sub 是已经落库的结果，notice 是「还差一步」的可读，页面照原样显示 */
export const SubscriptionResultSchema = z.object({
  sub: SubscriptionSchema,
  notice: z.string().nullable(),
})
export type SubscriptionResult = z.infer<typeof SubscriptionResultSchema>


export const PatchSubscriptionRequestSchema = z.object({
  enableAi: z.boolean().optional(),
  pushKindMode: z.enum(['inherit', 'custom']).optional(),
  pushKinds: DynamicKindConfigSchema.nullable().optional(),
  filterMode: z.enum(['inherit', 'custom']).optional(),
  promptTemplate: PromptTemplateSchema.nullable().optional(),
})
export type PatchSubscriptionRequest = z.infer<typeof PatchSubscriptionRequestSchema>

/** 更新流的查询串。被过滤的默认也列出来（灰显），filtered=0 才只看通过的 */
export const UpdatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  uid: z.string().optional(),
  before: z.coerce.number().int().optional(),
  filtered: z.enum(['0', '1']).default('1'),
})
export type UpdatesQuery = z.infer<typeof UpdatesQuerySchema>

export const UpsMapSchema = z.record(
  z.string(),
  z.object({ name: z.string(), face: z.string().nullable() }),
)
export type UpsMap = z.infer<typeof UpsMapSchema>

export const UpdatesResponseSchema = z.object({
  updates: z.array(UpdateSchema),
  ups: UpsMapSchema,
})
export type UpdatesResponse = z.infer<typeof UpdatesResponseSchema>

export const PollResultSchema = z.object({
  ok: z.boolean(),

  found: z.number().int().min(0),

  skipped: z.number().int().min(0),
  blocked: z.number().int().min(0),

  reason: z.string().nullable(),
})
export type PollResult = z.infer<typeof PollResultSchema>

export const JobsResponseSchema = z.object({
  jobs: z.array(SummaryJobSchema),
  videos: z.record(
    z.string(),
    z.object({ title: z.string(), url: z.string(), readerPath: z.string().nullable() }),
  ),
})
export type JobsResponse = z.infer<typeof JobsResponseSchema>

/** 索引里一行的状态。互斥且穷举 —— 每行都得有个明确标记，不能是空无效 */
export const SummaryStateSchema = z.enum([
  'done',
  'running',
  'pending',
  'failed',

  'filtered',

  'none',
])
export type SummaryState = z.infer<typeof SummaryStateSchema>

export const SUMMARY_STATE_LABEL: Record<SummaryState, string> = {
  done: '已总结',
  running: '处理中',
  pending: '排队中',
  failed: '失败',
  filtered: '已拦下',
  none: '未总结',
}

/** 解析状态。**没有「已拦下」** —— 过滤规则拦的是「自动解析」与「推送」这两个动作， 不是条目本身，所以它不应占掉单条动态的状态位 */
export const ParseStateSchema = SummaryStateSchema.exclude(['filtered'])
export type ParseState = z.infer<typeof ParseStateSchema>

export const PARSE_STATE_LABEL: Record<ParseState, string> = {
  done: '已解析',
  running: '解析中',
  pending: '排队中',
  failed: '解析失败',
  none: '未解析',
}


export const ReaderItemSchema = z.object({
  dynId: z.string(),
  uid: z.string(),
  type: DynamicTypeSchema,
  pubTs: z.number().int(),
  title: z.string().nullable(),
  text: z.string().nullable(),

  desc: z.string().nullable(),
  cover: z.string().nullable(),
  /** 图文的多图。只走接口不落库 */
  pics: z.array(z.string()),
  bvid: z.string().nullable(),
  url: z.string(),
  inDb: z.boolean(),
  state: ParseStateSchema,
  /** 有总结才有。左栏据此标「走了哪级降级」 */
  degradePath: DegradePathSchema.nullable(),

  filterReason: z.string().nullable(),
  jobStage: JobStageSchema.nullable(),
})
export type ReaderItem = z.infer<typeof ReaderItemSchema>

/** 索引的翻页游标：before 是上一页最后扫到应项的 pubTs */
export const SummariesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(40),
  before: z.coerce.number().int().optional(),
})
export type SummariesQuery = z.infer<typeof SummariesQuerySchema>

export const SummariesResponseSchema = z.object({
  items: z.array(ReaderItemSchema),
  ups: UpsMapSchema,

  filteredCount: z.number().int().min(0),
  /** 下一页的游标；null = 到底了 */
  nextBefore: z.number().int().nullable(),
})
export type SummariesResponse = z.infer<typeof SummariesResponseSchema>

export const UpFeedQuerySchema = z.object({
  /** B 站给的游标，原样带回来。首页不传 */
  offset: z.string().optional(),
})
export type UpFeedQuery = z.infer<typeof UpFeedQuerySchema>

export const UpFeedResponseSchema = z.object({
  up: z.object({ uid: z.string(), name: z.string(), face: z.string().nullable() }),
  items: z.array(ReaderItemSchema),
  /** B 站给的下一页游标。hasMore=false 时是 null */
  hasMore: z.boolean(),
  offset: z.string().nullable(),
})
export type UpFeedResponse = z.infer<typeof UpFeedResponseSchema>

/** 单条。深链接进来时右栏不必等左栏翻到那一页 */
export const ReaderItemResponseSchema = z.object({ item: ReaderItemSchema })
export type ReaderItemResponse = z.infer<typeof ReaderItemResponseSchema>


export const TranscriptResponseSchema = z.object({
  bvid: z.string(),
  source: TranscriptSourceSchema,
  text: z.string(),
})
export type TranscriptResponse = z.infer<typeof TranscriptResponseSchema>


export const VideoUsageSchema = z.object({
  calls: z.number().int().min(0),
  inTokens: z.number().int().min(0),
  outTokens: z.number().int().min(0),
  ms: z.number().int().min(0),
})
export type VideoUsage = z.infer<typeof VideoUsageSchema>


export const SummaryDetailResponseSchema = z.object({
  bvid: z.string(),

  state: SummaryStateSchema,
  update: UpdateSchema.nullable(),
  up: z.object({ name: z.string(), face: z.string().nullable() }).nullable(),
  summary: SummarySchema.nullable(),
  job: SummaryJobSchema.nullable(),
  usage: VideoUsageSchema,
  deliveries: z.array(
    z.object({
      channel: z.string(),
      kind: DeliveryKindSchema,
      status: DeliveryStatusSchema,
      at: z.number().int(),
      error: z.string().nullable(),
    }),
  ),
})
export type SummaryDetailResponse = z.infer<typeof SummaryDetailResponseSchema>

export const RulesResponseSchema = z.object({
  rules: z.array(FilterRuleSchema),
  /** 规则 id → 正则超时次数。只列有过超时的 */
  timeouts: z.record(z.string(), z.number().int()),
})
export type RulesResponse = z.infer<typeof RulesResponseSchema>

export const AddRuleRequestSchema = z.object({
  scope: RuleScopeSchema,
  kind: RuleKindSchema,
  pattern: z.string().min(1),
  enabled: z.boolean().default(true),
})
export type AddRuleRequest = z.infer<typeof AddRuleRequestSchema>

export const PatchRuleRequestSchema = z.object({ enabled: z.boolean() })
export type PatchRuleRequest = z.infer<typeof PatchRuleRequestSchema>

/** 样本测试框的入参。uid 为空表示只用全局规则试 */
export const TestRulesRequestSchema = z.object({
  sample: z.string().min(1),
  uid: z.string().nullable().default(null),
})
export type TestRulesRequest = z.infer<typeof TestRulesRequestSchema>

export const TestRulesResponseSchema = z.object({
  hits: z.array(z.object({ id: z.number().int(), label: z.string(), timedOut: z.boolean() })),
  verdict: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pass') }),
    z.object({ kind: z.literal('blocked'), reason: z.string() }),
    z.object({ kind: z.literal('held'), reason: z.string() }),
  ]),

  used: z.array(FilterRuleSchema),
})
export type TestRulesResponse = z.infer<typeof TestRulesResponseSchema>

export const PromptSettingsResponseSchema = z.object({
  defaultTemplate: z.string(),
  customTemplate: z.string().nullable(),
  effectiveTemplate: z.string(),
  source: z.enum(['default', 'custom']),
  variables: z.array(z.enum(PROMPT_VARIABLES)),
})
export type PromptSettingsResponse = z.infer<typeof PromptSettingsResponseSchema>

export const PatchPromptSettingsRequestSchema = z.object({
  template: PromptTemplateSchema.nullable(),
})
export type PatchPromptSettingsRequest = z.infer<typeof PatchPromptSettingsRequestSchema>

export const DEFAULT_PROMPT_SETTINGS: PromptSettingsResponse = {
  defaultTemplate: DEFAULT_PROMPT_TEMPLATE,
  customTemplate: null,
  effectiveTemplate: DEFAULT_PROMPT_TEMPLATE,
  source: 'default',
  variables: [...PROMPT_VARIABLES],
}

/** apiKey 在响应里的唯一形态。明文永远不出服务端 */
export const SecretStateSchema = z.object({
  configured: z.boolean(),

  masked: z.string().nullable(),
  updatedAt: z.number().int().nullable(),
})
export type SecretState = z.infer<typeof SecretStateSchema>

export const AiSettingsResponseSchema = z.object({
  ai: AiConfigSchema,
  asr: AsrConfigSchema,
  availableAsrProviders: z.array(AsrProviderSchema),
  isDocker: z.boolean(),
  llmKey: SecretStateSchema,
  asrKey: SecretStateSchema,
})
export type AiSettingsResponse = z.infer<typeof AiSettingsResponseSchema>

/** apiKey 的三态由值本身表达：缺省或空串 = 不修改，null = 清空，其余 = 写新值。 「空串等于不修改」是因为表单只写不读 —— 用户没动那个框时它就是空的 */
export const PatchAiSettingsRequestSchema = z.object({
  ai: AiConfigSchema.partial().optional(),
  asr: AsrConfigSchema.partial().optional(),
  llmApiKey: z.string().nullable().optional(),
  asrApiKey: z.string().nullable().optional(),
})
export type PatchAiSettingsRequest = z.infer<typeof PatchAiSettingsRequestSchema>

export const AiTestResponseSchema = z.object({ llm: ProbeResultSchema, asr: ProbeResultSchema })
export type AiTestResponse = z.infer<typeof AiTestResponseSchema>

export const NotifyTargetStateSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  ready: z.boolean(),
})
export type NotifyTargetState = z.infer<typeof NotifyTargetStateSchema>

export const NotifySettingsResponseSchema = z.object({
  notify: NotifyConfigSchema,
  wxpusherToken: SecretStateSchema,
  pushplusToken: SecretStateSchema,
  ntfyAuth: SecretStateSchema,
  feishuSecret: SecretStateSchema,
  webhookAuthorization: SecretStateSchema,
  targets: z.object({
    wxpusher: NotifyTargetStateSchema,
    pushplus: NotifyTargetStateSchema,
    ntfy: NotifyTargetStateSchema,
    feishu: NotifyTargetStateSchema,
    webhook: NotifyTargetStateSchema,
  }),
})
export type NotifySettingsResponse = z.infer<typeof NotifySettingsResponseSchema>

export const PatchNotifySettingsRequestSchema = z.object({
  notify: z
    .object({
      wxpusher: z
        .object({
          enabled: z.boolean().optional(),
          uids: z.array(z.string().min(1)).optional(),
        })
        .optional(),
      pushplus: z
        .object({
          enabled: z.boolean().optional(),
          channel: z.enum(['wechat', 'app', 'webhook', 'cp', 'mail']).optional(),
          topic: z.string().optional(),
        })
        .optional(),
      ntfy: z
        .object({
          enabled: z.boolean().optional(),
          server: z.string().url().optional(),
          topic: z
            .string()
            .regex(/^$|^[-_A-Za-z0-9]{1,64}$/, 'topic 只能包含字母、数字、短横线和下划线，最长 64 位')
            .optional(),
        })
        .optional(),
      feishu: z
        .object({
          enabled: z.boolean().optional(),
          appId: z.string().optional(),
          receiveIdType: z.enum(['open_id', 'union_id', 'user_id', 'email', 'chat_id']).optional(),
          receiveId: z.string().optional(),
        })
        .optional(),
      webhook: z
        .object({
          enabled: z.boolean().optional(),
          url: z.union([z.literal(''), z.string().url()]).optional(),
        })
        .optional(),
    })
    .optional(),
  wxpusherToken: z.string().nullable().optional(),
  pushplusToken: z.string().nullable().optional(),
  ntfyAuth: z.string().nullable().optional(),
  feishuSecret: z.string().nullable().optional(),
  webhookAuthorization: z.string().nullable().optional(),
})
export type PatchNotifySettingsRequest = z.infer<typeof PatchNotifySettingsRequestSchema>

export const NotifyTestResponseSchema = z.object({
  channel: z.enum(['wxpusher', 'pushplus', 'ntfy', 'feishu', 'webhook']),
  result: z.object({
    ok: z.boolean(),
    externalId: z.string().nullable(),
    error: z.string().nullable(),
  }),
})
export type NotifyTestResponse = z.infer<typeof NotifyTestResponseSchema>

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),

    issues: z.array(z.object({ path: z.string(), message: z.string() })).nullable(),
  }),
})
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
