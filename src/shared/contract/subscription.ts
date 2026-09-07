import { z } from 'zod'

export const SubscriptionSchema = z.object({
  uid: z.string(),
  name: z.string(),
  face: z.string().nullable(),
  /** 三个独立开关：某个 UP 我可能只要视频不要碎动态、也可能要动态但不烧 AI。 */
  enableDynamic: z.boolean(),
  enableVideo: z.boolean(),
  enableAi: z.boolean(),
  /** 自动关注成功的时刻；null 表示还没关注上。 */
  followedAt: z.number().nullable(),
})
export type Subscription = z.infer<typeof SubscriptionSchema>

/** 全局默认规则 + per-UP 覆盖。scope 为 'global' 或某个 uid。 */
export const RuleScopeSchema = z.union([z.literal('global'), z.string()])

export const RuleKindSchema = z.enum([
  'keyword-allow',
  'keyword-deny',
  'regex-allow',
  'regex-deny',
])
export type RuleKind = z.infer<typeof RuleKindSchema>

export const FilterRuleSchema = z.object({
  id: z.number().int(),
  scope: RuleScopeSchema,
  kind: RuleKindSchema,
  pattern: z.string().min(1),
  enabled: z.boolean(),
})
export type FilterRule = z.infer<typeof FilterRuleSchema>
