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
  WandSparkles,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { AppShell } from '@/components/app-shell'

/** 10 页（spec Q34）。总结详情不是独立一页，而是 /reader/:uid/:dynId 的右栏。 导航分三组：看什么发生了 / 管订阅与过滤 / 配置。分组是为了让「可观测性」那几页 排在最前 —— 这个工作台的核心不是改配置 */
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
  { to: '/prompts', label: 'Prompt 管理', icon: WandSparkles, group: '系统' },
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
      {
        path: 'overview',
        lazy: async () => ({ Component: (await import('@/pages/overview')).OverviewPage }),
      },
      {
        path: 'updates',
        lazy: async () => ({ Component: (await import('@/pages/updates')).UpdatesPage }),
      },
      // 同一个页面：选中的 UP 和条目都在 URL 里，左栏不会因为选单条而重挂
      // 不带 uid 时页面自己落到第一个订阅上
      {
        path: 'reader',
        lazy: async () => ({ Component: (await import('@/pages/reader')).ReaderPage }),
      },
      {
        path: 'reader/:uid',
        lazy: async () => ({ Component: (await import('@/pages/reader')).ReaderPage }),
      },
      {
        path: 'reader/:uid/:dynId',
        lazy: async () => ({ Component: (await import('@/pages/reader')).ReaderPage }),
      },
      // 旧链接：总结页已经并进阅读页，避免让收藏夹里的地址 404
      { path: 'summaries', element: <Navigate to="/reader" replace /> },
      { path: 'summaries/:bvid', element: <Navigate to="/reader" replace /> },
      {
        path: 'jobs',
        lazy: async () => ({ Component: (await import('@/pages/jobs')).JobsPage }),
      },
      {
        path: 'subs',
        lazy: async () => ({ Component: (await import('@/pages/subs')).SubsPage }),
      },
      {
        path: 'rules',
        lazy: async () => ({ Component: (await import('@/pages/rules')).RulesPage }),
      },
      {
        path: 'targets',
        lazy: async () => ({ Component: (await import('@/pages/targets')).TargetsPage }),
      },
      {
        path: 'prompts',
        lazy: async () => ({ Component: (await import('@/pages/prompts')).PromptsPage }),
      },
      {
        path: 'ai',
        lazy: async () => ({ Component: (await import('@/pages/ai')).AiPage }),
      },
      {
        path: 'logs',
        lazy: async () => ({ Component: (await import('@/pages/logs')).LogsPage }),
      },
      {
        path: 'system',
        lazy: async () => ({ Component: (await import('@/pages/system')).SystemPage }),
      },
      { path: '*', element: <Navigate to="/overview" replace /> },
    ],
  },
])
