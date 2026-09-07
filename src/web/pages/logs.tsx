import { NotYet, Page } from '@/components/page'

export function LogsPage() {
  return (
    <Page title="日志" hint="SSE 实时日志流，按级别过滤。">
      <NotYet ticket="ticket 14 SSE 与实时" what="SSE 实时日志流，按级别过滤。" />
    </Page>
  )
}
