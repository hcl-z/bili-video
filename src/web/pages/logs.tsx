import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDownToLine, Eraser, Pause, Play, Search, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { LogFilter, LogLevelName, LogLine } from '#shared/contract/events.ts'
import { Page } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useLogStream } from '@/lib/use-log-stream'
import { cn } from '@/lib/utils'

/** 每一档只看那一档（Error 连 fatal 一起）。「全部」是唯一能看到 trace 的档。 */
const FILTERS: readonly { value: LogFilter; label: string; dot: string }[] = [
  { value: 'all', label: '全部', dot: 'bg-muted-foreground/60' },
  { value: 'debug', label: 'Debug', dot: 'bg-muted-foreground' },
  { value: 'info', label: 'Info', dot: 'bg-emerald-500' },
  { value: 'warn', label: 'Warn', dot: 'bg-amber-500' },
  { value: 'error', label: 'Error', dot: 'bg-destructive' },
]

/** 级别色块。warn 与 error 用实底 —— 它们要在几十行里被一眼扫到，描边不够。 */
const LEVEL_BADGE: Record<LogLevelName, string> = {
  trace: 'bg-muted text-muted-foreground',
  debug: 'bg-muted text-muted-foreground',
  info: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  warn: 'bg-amber-500/90 text-amber-950',
  error: 'bg-destructive text-white',
  fatal: 'bg-destructive text-white',
}

/** `[模块]` 的颜色。warn 及以上跟级别走，其余用强调色 —— 不为它引入第二个色相。 */
const MOD_COLOR: Record<LogLevelName, string> = {
  trace: 'text-brand-ink/70',
  debug: 'text-brand-ink/70',
  info: 'text-brand-ink',
  warn: 'text-amber-700 dark:text-amber-400',
  error: 'text-destructive',
  fatal: 'text-destructive',
}

const TIME = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** 离底多少像素内算「还在底部」。滚轮的一格就有几十像素，卡太死会误判成「用户翻上去了」。 */
const AT_BOTTOM_PX = 24
/** 字段值超过这个长度就掐中间。URL 和路径的关键信息在两头，掐尾巴等于什么都没说。 */
const MAX_VALUE_CHARS = 110

export function LogsPage() {
  const [filter, setFilter] = useState<LogFilter>('all')
  const [query, setQuery] = useState('')
  const [mod, setMod] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const { lines, connected, clear } = useLogStream(filter, paused)
  const scroller = useRef<HTMLDivElement>(null)

  // 档位在服务端过滤，搜索和模块在本地 —— 它们改起来太频繁，每敲一个字重连一次流不值得。
  const shown = useMemo(
    () => lines.filter((l) => (mod === null || l.mod === mod) && matches(l, query)),
    [lines, mod, query],
  )

  useEffect(() => {
    if (!follow) return
    const el = scroller.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [shown, follow])

  return (
    <Page title="日志" hint="服务端实时流，按级别筛选。文件按天轮转、留 7 天。" wide>
      <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-2">
        {/*
          分段控件，视觉和 shadcn 的 TabsList 一套：底槽 bg-muted，选中的那一档浮起来
          （bg-background + 阴影）。选中态不用强调色 —— 五个档已经各有一颗语义色点，
          再压一块粉底进去就成了两个信号打架。
        */}
        <div
          className="bg-muted inline-flex h-8 shrink-0 items-center rounded-lg p-[3px]"
          role="group"
          aria-label="日志级别"
        >
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                'focus-visible:ring-ring/50 flex h-full items-center gap-1.5 rounded-md px-2.5 text-xs transition-all outline-none focus-visible:ring-[3px]',
                filter === f.value
                  ? 'bg-background text-foreground font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full transition-opacity',
                  f.dot,
                  filter === f.value ? 'opacity-100' : 'opacity-60',
                )}
                aria-hidden
              />
              {f.label}
            </button>
          ))}
        </div>

        <div className="relative min-w-40 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜消息、模块、字段值"
            aria-label="搜索日志"
            className="h-8 pl-8 text-xs"
          />
        </div>

        {mod !== null && (
          <Button variant="secondary" size="xs" onClick={() => setMod(null)}>
            {mod}
            <X />
          </Button>
        )}

        <Action
          onClick={() => setPaused(!paused)}
          icon={paused ? Play : Pause}
          label={paused ? '继续' : '暂停'}
          active={paused}
        />
        <Action onClick={clear} icon={Eraser} label="清屏" />
      </div>

      <Card className="overflow-hidden py-0">
        {/*
          定高而不是 max-height：行是一条条冒出来的，高度跟着行数长会让整页一直往下窜。
        */}
        <CardContent
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            // 翻上去看东西时自动停掉跟随，回到底部再自动接上 —— 不然新行会把人拽回去。
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX)
          }}
          className="h-[62vh] min-h-72 overflow-y-auto px-3 py-2.5"
        >
          {shown.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              {lines.length === 0 ? '这一档还没有日志。' : '没有匹配这个条件的行。'}
            </p>
          ) : (
            <ul>
              {shown.map((line, i) => (
                <Row
                  key={`${line.at}-${i}`}
                  line={line}
                  query={query.trim()}
                  onMod={() => setMod(line.mod)}
                />
              ))}
            </ul>
          )}
        </CardContent>

        <div className="text-muted-foreground flex items-center gap-3 border-t px-3 py-2 text-xs">
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={follow}
            onClick={() => setFollow(true)}
            disabled={follow}
            className={cn('-ml-1', follow && 'text-emerald-600 dark:text-emerald-400')}
          >
            <ArrowDownToLine />
            {follow ? '跟到最新' : '回到最新'}
          </Button>
          <div className="flex-1" />
          <span className="font-mono tabular-nums">
            {shown.length === lines.length ? `${lines.length} 行` : `${shown.length}/${lines.length} 行`}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                'size-2 rounded-full',
                paused
                  ? 'bg-amber-500'
                  : connected
                    ? 'bg-brand'
                    : 'bg-muted-foreground/40 animate-pulse',
              )}
              aria-hidden
            />
            {paused ? '已暂停' : connected ? '实时' : '连接中'}
          </span>
        </div>
      </Card>
    </Page>
  )
}

function Row(props: { line: LogLine; query: string; onMod: () => void }) {
  const { line, query } = props
  return (
    <li className="hover:bg-muted/50 flex gap-3 rounded px-1 py-[3px] font-mono text-xs leading-5">
      <span className="text-muted-foreground shrink-0 tabular-nums">{TIME.format(line.at)}</span>
      {/* 定宽：级别名长短不一，不定宽的话后面的消息列会参差不齐。 */}
      <span
        className={cn(
          'w-[3.25rem] shrink-0 rounded-sm px-1.5 text-center text-[10px] font-semibold uppercase leading-5 tracking-wide',
          LEVEL_BADGE[line.level],
        )}
      >
        {line.level}
      </span>
      <span className="min-w-0 flex-1 break-words">
        {line.mod !== null && (
          <button
            type="button"
            onClick={props.onMod}
            title={`只看 ${line.mod}`}
            className={cn('hover:underline', MOD_COLOR[line.level])}
          >
            [{line.mod}]
          </button>
        )}{' '}
        <Mark text={line.msg} query={query} />
        {Object.entries(line.data).map(([key, value]) => {
          const full = render(value)
          return (
            <span key={key} className="text-muted-foreground ml-2.5" title={full}>
              {key}=
              <span className="text-foreground/80">
                <Mark text={short(full)} query={query} />
              </span>
            </span>
          )
        })}
        {line.err !== null && (
          <span className="text-destructive ml-2.5">
            <Mark text={line.err} query={query} />
          </span>
        )}
      </span>
    </li>
  )
}

function Action(props: { onClick: () => void; icon: LucideIcon; label: string; active?: boolean }) {
  const Icon = props.icon
  return (
    <Button
      variant="ghost"
      size="xs"
      {...(props.active === undefined ? {} : { 'aria-pressed': props.active })}
      onClick={props.onClick}
      className={cn('shrink-0', props.active === true ? 'text-brand-ink' : 'text-muted-foreground')}
    >
      <Icon />
      {props.label}
    </Button>
  )
}

function Mark(props: { text: string; query: string }) {
  if (props.query === '') return props.text
  const hay = props.text.toLowerCase()
  const needle = props.query.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, from)) {
    if (at > from) parts.push(props.text.slice(from, at))
    parts.push(
      <mark key={at} className="bg-brand/25 text-foreground rounded-[2px]">
        {props.text.slice(at, at + needle.length)}
      </mark>,
    )
    from = at + needle.length
  }
  parts.push(props.text.slice(from))
  return parts
}

/** 搜索范围是整行：消息、模块、字段名、字段值、错误摘要。只搜消息的话字段就白带了。 */
function matches(line: LogLine, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  if (line.msg.toLowerCase().includes(needle)) return true
  if (line.mod !== null && line.mod.toLowerCase().includes(needle)) return true
  if (line.err !== null && line.err.toLowerCase().includes(needle)) return true
  return Object.entries(line.data).some(
    ([k, v]) => k.toLowerCase().includes(needle) || render(v).toLowerCase().includes(needle),
  )
}

/** 掐中间：URL 和路径两头才是有信息的部分。全文在 title 里。 */
function short(text: string): string {
  if (text.length <= MAX_VALUE_CHARS) return text
  return `${text.slice(0, MAX_VALUE_CHARS - 38)}…${text.slice(-32)}`
}

/** 字段值压成一行。对象与数组走 JSON —— 日志行不该为一个字段铺开一棵树。 */
function render(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  return JSON.stringify(value)
}
