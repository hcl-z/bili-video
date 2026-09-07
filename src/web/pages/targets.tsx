import { NotYet, Page } from '@/components/page'

export function TargetsPage() {
  return (
    <Page title="推送渠道" hint="WxPusher 与 ntfy 的配置与连通性测试。">
      <NotYet ticket="ticket 11 推送渠道" what="WxPusher 与 ntfy 的配置与连通性测试。" />
    </Page>
  )
}
