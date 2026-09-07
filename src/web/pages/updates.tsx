import { NotYet, Page } from '@/components/page'

export function UpdatesPage() {
  return (
    <Page title="动态流" hint="每条动态为什么推了、为什么没推，都能在这儿看到原因。">
      <NotYet ticket="ticket 04 轮询与去重 / 06 过滤" what="每条动态为什么推了、为什么没推，都能在这儿看到原因。" />
    </Page>
  )
}
