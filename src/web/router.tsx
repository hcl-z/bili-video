import { createBrowserRouter, Navigate } from 'react-router-dom'
import {
  Activity,
  Bell,
  BookOpen,
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
import { ReaderPage } from '@/pages/reader'
import { RulesPage } from '@/pages/rules'
import { SubsPage } from '@/pages/subs'
import { SystemPage } from '@/pages/system'
import { TargetsPage } from '@/pages/targets'
import { UpdatesPage } from '@/pages/updates'

/**
 * 10 页（spec Q34）。总结详情不是独立一页，而是 /reader/:uid/:dynId 的右栏。
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
  { to: '/reader', label: '阅读', icon: BookOpen, group: '监听' },
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
      // 同一个页面：选中的 UP 和条目都在 URL 里，左栏不会因为选一条而重挂。
      // 不带 uid 时页面自己落到第一个订阅上。
      { path: 'reader', element: <ReaderPage /> },
      { path: 'reader/:uid', element: <ReaderPage /> },
      { path: 'reader/:uid/:dynId', element: <ReaderPage /> },
      // 旧链接：总结页已经并进阅读页，别让收藏夹里的地址 404。
      { path: 'summaries', element: <Navigate to="/reader" replace /> },
      { path: 'summaries/:bvid', element: <Navigate to="/reader" replace /> },
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
