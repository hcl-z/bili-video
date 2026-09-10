import type { ReactNode } from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'


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
