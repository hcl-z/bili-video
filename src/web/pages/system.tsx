import { NotYet, Page } from '@/components/page'

export function SystemPage() {
  return (
    <Page title="系统" hint="登录态、备份提醒、配置真相说明。">
      <NotYet ticket="ticket 02 扫码登录 / 15 系统页" what="登录态、备份提醒、配置真相说明。" />
    </Page>
  )
}
