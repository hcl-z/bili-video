import { z } from 'zod'

/** 连通性测试的结果。放在 shared 而不是 domain，是因为工作台要把它显示出来 —— 和 failure.ts 同一个理由 */

/** 测试卡在哪一步。分开报是因为三种失败的处置完全不同 */
export const ProbeStageSchema = z.enum([
  /** baseURL / model 还没填，或本地那个可执行文件没装 */
  'not-configured',
  /** 连不上：DNS、超时、拒绝连接 */
  'network',
  /** 连上了但 apiKey 不对 */
  'auth',

  'model',
  'unknown',
])
export type ProbeStage = z.infer<typeof ProbeStageSchema>

export const ProbeResultSchema = z.object({
  ok: z.boolean(),
  ms: z.number().int().min(0),

  stage: ProbeStageSchema.nullable(),

  detail: z.string().nullable(),
})
export type ProbeResult = z.infer<typeof ProbeResultSchema>
