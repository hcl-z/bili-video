import { Moon, Sun } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'

import { HealthDot } from '@/components/health-dot'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useServerEvents } from '@/lib/use-sse'
import { useTheme } from '@/lib/theme'
import { NAV, type NavItem } from '@/router'

const GROUPS: NavItem['group'][] = ['监听', '订阅', '系统']

/**
 * 分栏阅读：60px 顶栏 + 260px 索引栏 + 正文。
 *
 * 正文列限宽（`max-w-[72ch]` 由各页自己控制），因为这个工作台一半时间是在**读总结**，
 * 不是在填表 —— 通栏的一行字看着累。
 */
export function AppShell() {
  const { theme, toggle } = useTheme()
  // 全站一条 SSE 连接，事件到了自动失效对应查询。
  useServerEvents()

  return (
    <div className="min-h-screen">
      <header
        className="bg-background/85 fixed inset-x-0 top-0 z-20 flex items-center gap-3 border-b px-4 backdrop-blur"
        style={{ height: 'var(--appbar-h)' }}
      >
        <span className="bg-brand size-2.5 rounded-full" aria-hidden />
        <span className="text-sm font-semibold tracking-tight">B 站监听工作台</span>
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

      <main
        className="px-6 py-6 md:pl-[calc(var(--index-w)+1.5rem)]"
        style={{ paddingTop: 'calc(var(--appbar-h) + 1.5rem)' }}
      >
        <Outlet />
      </main>
    </div>
  )
}
