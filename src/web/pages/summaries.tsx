import { NotYet, Page } from '@/components/page'

export function SummariesPage() {
  return (
    <Page title="总结" hint="左侧索引 + 右侧当文章读；每条标出走了哪级降级。">
      <NotYet ticket="ticket 10 总结产出" what="左侧索引 + 右侧当文章读；每条标出走了哪级降级。" />
    </Page>
  )
}
