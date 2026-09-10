import { useEffect, useState } from 'react'

/** 亮暗主题共用 shadcn 所需的 `.dark` class。 localStorage 无记录时跟随系统；有记录时使用用户显式选择。首屏由 index.html 内联脚本决定以避免闪无效 */
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
      // 隐私模式无法写入时仍在内存切换，刷新后恢复为跟随系统
    }
    setChoice(next)
  }


  function toggle(): void {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }

  return { choice, theme, setTheme, toggle }
}
