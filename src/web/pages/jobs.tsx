import { NotYet, Page } from '@/components/page'

export function JobsPage() {
  return (
    <Page title="队列" hint="任务堵在哪一步、重试了几次。">
      <NotYet ticket="ticket 09 总结队列" what="任务堵在哪一步、重试了几次。" />
    </Page>
  )
}
