import { z } from 'zod'

/** 五类动态。只有 AV 走总结管线（spec Q6）。 */
export const DynamicTypeSchema = z.enum(['AV', 'DRAW', 'WORD', 'FORWARD', 'ARTICLE'])
export type DynamicType = z.infer<typeof DynamicTypeSchema>

export const UpdateSchema = z.object({
  dynId: z.string(),
  uid: z.string(),
  type: DynamicTypeSchema,
  /** B 站给的发布时间，秒。锚点按它单调推进。 */
  pubTs: z.number().int(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  cover: z.string().nullable(),
  bvid: z.string().nullable(),
  url: z.string(),
  /** 被过滤的条目照样入库 —— 「为什么这条没推给我」要有地方回答。 */
  filtered: z.boolean(),
  filterReason: z.string().nullable(),
  createdAt: z.number().int(),
})
export type Update = z.infer<typeof UpdateSchema>

/** 落库时带上原始 payload，便于事后核对 parser。 */
export type UpdateWithRaw = Update & { raw: unknown }
