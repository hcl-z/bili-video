import { NotYet, Page } from '@/components/page'

export function SummaryDetailPage() {
  return (
    <Page title="总结详情" hint="章节、逐字稿来源、token 花费。">
      <NotYet ticket="ticket 10 总结产出" what="章节、逐字稿来源、token 花费。" />
    </Page>
  )
}
