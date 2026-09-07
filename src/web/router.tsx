import { createBrowserRouter, Navigate } from 'react-router-dom'
import {
  Activity,
  Bell,
  FileText,
  Filter,
  ListChecks,
  Radio,
  ScrollText,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { AppShell } from '@/components/app-shell'
import { AiPage } from '@/pages/ai'
import { JobsPage } from '@/pages/jobs'
import { LogsPage } from '@/pages/logs'
import { OverviewPage } from '@/pages/overview'
import { RulesPage } from '@/pages/rules'
import { SubsPage } from '@/pages/subs'
import { SummariesPage } from '@/pages/summaries'
import { SummaryDetailPage } from '@/pages/summary-detail'
import { SystemPage } from '@/pages/system'
import { TargetsPage } from '@/pages/targets'
import { UpdatesPage } from '@/pages/updates'

/**
 * 10 页（spec Q34）。SummaryDetail 是 Summaries 的子路由，不单独占一格导航。
 *
 * 导航分三组：看什么发生了 / 管订阅与过滤 / 配置。分组是为了让「可观测性」那几页
 * 排在最前 —— 这个工作台的核心不是改配置。
 */
export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  group: '监听' | '订阅' | '系统'
}

export const NAV: NavItem[] = [
  { to: '/overview', label: '总览', icon: Activity, group: '监听' },
  { to: '/updates', label: '动态流', icon: Radio, group: '监听' },
  { to: '/summaries', label: '总结', icon: FileText, group: '监听' },
  { to: '/jobs', label: '队列', icon: ListChecks, group: '监听' },
  { to: '/subs', label: 'UP 主', icon: Users, group: '订阅' },
  { to: '/rules', label: '过滤规则', icon: Filter, group: '订阅' },
  { to: '/targets', label: '推送渠道', icon: Bell, group: '订阅' },
  { to: '/ai', label: 'AI 与 ASR', icon: Sparkles, group: '系统' },
  { to: '/logs', label: '日志', icon: ScrollText, group: '系统' },
  { to: '/system', label: '系统', icon: Settings, group: '系统' },
]

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      { path: 'overview', element: <OverviewPage /> },
      { path: 'updates', element: <UpdatesPage /> },
      { path: 'summaries', element: <SummariesPage /> },
      { path: 'summaries/:bvid', element: <SummaryDetailPage /> },
      { path: 'jobs', element: <JobsPage /> },
      { path: 'subs', element: <SubsPage /> },
      { path: 'rules', element: <RulesPage /> },
      { path: 'targets', element: <TargetsPage /> },
      { path: 'ai', element: <AiPage /> },
      { path: 'logs', element: <LogsPage /> },
      { path: 'system', element: <SystemPage /> },
      { path: '*', element: <Navigate to="/overview" replace /> },
    ],
  },
])
