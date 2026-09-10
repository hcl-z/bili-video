import { z } from 'zod'

export const SubscriptionSchema = z.object({
  uid: z.string(),
  name: z.string(),
  face: z.string().nullable(),

  enableDynamic: z.boolean(),
  enableVideo: z.boolean(),
  enableAi: z.boolean(),
  /** 自动关注成功的时刻；null 表示还没关注上 */
  followedAt: z.number().nullable(),
})
export type Subscription = z.infer<typeof SubscriptionSchema>


export const RuleScopeSchema = z.union([z.literal('global'), z.string()])
export type RuleScope = z.infer<typeof RuleScopeSchema>

export const RuleKindSchema = z.enum([
  'keyword-allow',
  'keyword-deny',
  'regex-allow',
  'regex-deny',
])
export type RuleKind = z.infer<typeof RuleKindSchema>

export const RULE_KIND_LABEL: Record<RuleKind, string> = {
  'keyword-deny': '关键词黑名单',
  'keyword-allow': '关键词白名单',
  'regex-deny': '正则黑名单',
  'regex-allow': '正则白名单',
}

export const RULE_KINDS = RuleKindSchema.options

export const FilterRuleSchema = z.object({
  id: z.number().int(),
  scope: RuleScopeSchema,
  kind: RuleKindSchema,
  pattern: z.string().min(1),
  enabled: z.boolean(),
})
export type FilterRule = z.infer<typeof FilterRuleSchema>
