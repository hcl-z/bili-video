import { NotYet, Page } from '@/components/page'

export function RulesPage() {
  return (
    <Page title="过滤规则" hint="关键词与正则黑白名单，带正则试跑。">
      <NotYet ticket="ticket 06 过滤" what="关键词与正则黑白名单，带正则试跑。" />
    </Page>
  )
}
