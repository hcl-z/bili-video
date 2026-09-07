import { NotYet, Page } from '@/components/page'

export function AiPage() {
  return (
    <Page title="AI 与 ASR" hint="模型、分段参数、token 用量；apiKey 只写不读。">
      <NotYet ticket="ticket 07 字幕与 ASR / 08 LLM" what="模型、分段参数、token 用量；apiKey 只写不读。" />
    </Page>
  )
}
