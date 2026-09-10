import { Suspense } from 'react'
import { Moon, Sun } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'

import { HealthDot } from '@/components/health-dot'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useServerEvents } from '@/lib/use-sse'
import { useTheme } from '@/lib/theme'
import { NAV, type NavItem } from '@/router'

const GROUPS: NavItem['group'][] = ['监听', '订阅', '系统']


export function AppShell() {
  const { theme, toggle } = useTheme()
  // 全站单条 SSE 连接，事件到了自动失效对应查询
  useServerEvents()

  return (
    <div className="min-h-screen">
      <header
        className="bg-background/85 fixed inset-x-0 top-0 z-20 flex items-center gap-3 border-b px-4 backdrop-blur"
        style={{ height: 'var(--appbar-h)' }}
      >
        <img src="/app-icon.png" alt="" className="size-7 rounded-md" />
        <span className="text-sm font-semibold tracking-tight">B站动态雷达</span>
        <div className="flex-1" />
        <HealthDot />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={toggle} aria-label="切换亮暗主题">
              {theme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>切换主题（默认跟随系统）</TooltipContent>
        </Tooltip>
      </header>

      <nav
        className="bg-sidebar fixed bottom-0 left-0 z-10 hidden border-r md:block"
        style={{ top: 'var(--appbar-h)', width: 'var(--index-w)' }}
        aria-label="页面索引"
      >
        <ScrollArea className="h-full px-3 py-4">
          {GROUPS.map((group) => (
            <div key={group} className="mb-5">
              <p className="text-muted-foreground px-2 pb-1.5 text-xs font-medium">{group}</p>
              <ul className="space-y-0.5">
                {NAV.filter((n) => n.group === group).map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                          isActive
                            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                            : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                        )
                      }
                    >
                      <item.icon className="size-4 shrink-0" />
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </ScrollArea>
      </nav>

      {}
      <main className="md:pl-[var(--index-w)]" style={{ paddingTop: 'var(--appbar-h)' }}>
        <Suspense
          fallback={
            <div className="mx-auto w-full max-w-[72ch] space-y-4 px-6 py-6">
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </div>
  )
}
