import { useEffect, useState } from 'react'

/**
 * 亮暗双主题跟随系统。
 *
 * 只有一个 `.dark` class（shadcn 的组件都按这个写的），存不存 localStorage 是「手动覆盖」的开关：
 * 没存过 = 跟随系统，存过 = 用户显式选了，系统再变也不跟。
 *
 * 首屏的那次判定在 index.html 的内联脚本里做，避免亮色闪一下。这里只负责后续变化。
 */
export type ThemeChoice = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const KEY = 'theme'
const query = () => window.matchMedia('(prefers-color-scheme: dark)')

function readChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY)
    return saved === 'dark' || saved === 'light' ? saved : 'system'
  } catch {
    return 'system'
  }
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  if (choice !== 'system') return choice
  return query().matches ? 'dark' : 'light'
}

function apply(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice)
  const theme = resolve(choice)

  useEffect(() => {
    apply(theme)
  }, [theme])

  // 跟随系统时监听系统切换；用户显式选过就不再跟。
  useEffect(() => {
    if (choice !== 'system') return
    const mq = query()
    const onChange = () => apply(resolve('system'))
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [choice])

  function setTheme(next: ThemeChoice): void {
    try {
      if (next === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch {
      // 隐私模式下写不进去：内存里照样切，只是刷新后回到跟随系统。
    }
    setChoice(next)
  }

  /** 一键在亮/暗之间翻，翻完就是显式选择，不再跟随系统。 */
  function toggle(): void {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }

  return { choice, theme, setTheme, toggle }
}
