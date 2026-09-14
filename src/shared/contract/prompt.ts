import { z } from 'zod'

export const PROMPT_VARIABLES = ['text', 'title', 'up_name', 'bvid'] as const
export type PromptVariable = (typeof PROMPT_VARIABLES)[number]

export const DEFAULT_PROMPT_TEMPLATE = `请把下面的视频内容重写成一篇完整的中文阅读版文章，让读者不看视频也能理解作者讲了什么。

视频标题：{{title}}
UP 主：{{up_name}}
BV 号：{{bvid}}

输出要求：
1. 先用一段 Overview 点明核心论题与结论。
2. 按主题划分小节，详细保留作者的论证、步骤、关键数字、定义和原话。
3. 若能抽象出框架或心智模型，用清晰的步骤或段落展开。
4. 内容中的时间戳请保留，用于定位原视频。
5. 不新增视频中没有的事实；含混处保持原意并注明不确定性。
6. 专有名词保留原文，段落过长时可使用列表拆分。
7. 不要高度浓缩，不要复述这些写作要求。

视频内容：
{{text}}`

const KNOWN_VARIABLE = new Set<string>(PROMPT_VARIABLES)
const VARIABLE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

export const PromptTemplateSchema = z
  .string()
  .trim()
  .min(1, 'Prompt 不能为空')
  .max(30_000, 'Prompt 最长 30000 字符')
  .superRefine((template, ctx) => {
    const variables = [...template.matchAll(VARIABLE)].map((match) => match[1] ?? '')
    const unknown = [...new Set(variables.filter((variable) => !KNOWN_VARIABLE.has(variable)))]
    if (unknown.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `未知变量：${unknown.join('、')}` })
    }
    const textCount = variables.filter((variable) => variable === 'text').length
    if (textCount !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '{{text}} 必须且只能出现一次' })
    }
  })

export type PromptTemplate = z.infer<typeof PromptTemplateSchema>

export function renderPromptTemplate(
  template: string,
  values: Record<PromptVariable, string>,
): string {
  return template.replace(VARIABLE, (raw, variable: string) =>
    KNOWN_VARIABLE.has(variable) ? values[variable as PromptVariable] : raw,
  )
}
