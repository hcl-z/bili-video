import type { ReactNode } from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * 配置与列表页的正文列。限宽是刻意的，通栏一行字看着累；总结页通栏铺满，不走这里。
 *
 * `wide` 是给日志这类「一行是记录不是句子」的页面留的口子：日志行有时间、级别、模块、
 * 字段四段，压进 72ch 会全部折行。
 */
export function Page(props: {
  title: string
  hint?: string
  wide?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={cn('mx-auto w-full px-6 py-6', props.wide === true ? 'max-w-none' : 'max-w-[72ch]')}
    >
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">{props.title}</h1>
        {props.hint !== undefined && (
          <p className="text-muted-foreground mt-1 text-sm">{props.hint}</p>
        )}
      </header>
      {props.children}
    </div>
  )
}

/**
 * 还没做的页面。写清「哪一票会做」比放假数据好 —— 假数据会让人以为功能坏了，
 * 也会在后面几票里被当成真实现留下来。
 */
export function NotYet(props: { ticket: string; what: string }) {
  return (
    <Card>
      <CardContent className="text-muted-foreground py-8 text-center text-sm">
        <p className="text-foreground font-medium">这一页还没做</p>
        <p className="mt-1.5">{props.what}</p>
        <p className="mt-3 font-mono text-xs">{props.ticket}</p>
      </CardContent>
    </Card>
  )
}
