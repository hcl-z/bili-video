import { Check, ChevronsRight, Loader2, Minus, RotateCcw, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { JobStep, PipelineStep, StepStatus, SummaryJob } from '#shared/contract/job.ts'
import { JOB_STAGE_LABEL, PIPELINE_STEPS, STEP_STATUS_LABEL } from '#shared/contract/job.ts'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useRetryJob } from '@/lib/use-retry-job'
import { cn } from '@/lib/utils'

/**
 * 六步流水线。每一步一个圆点，点某一步就是「从这儿重跑」——
 * 它之前那几步的产物（字幕/转写、分段要点、总结草稿）照用，不重复跑。
 */
export function JobPipeline(props: { job: SummaryJob }) {
  const { job } = props
  const retry = useRetryJob(job.id)
  const byStep = new Map(job.steps.map((s) => [s.step, s]))
  // 跑着的任务点了也会被后端挡回来，别给一个假的可点。
  const canRerun = job.status !== 'running' && job.status !== 'pending'

  return (
    <div className="flex items-center">
      {PIPELINE_STEPS.map((step, i) => (
        <div key={step} className="flex items-center">
          {i > 0 && <span className="bg-border h-px w-4 shrink-0 sm:w-6" aria-hidden />}
          <Dot
            step={step}
            record={byStep.get(step) ?? null}
            current={job.status === 'running' && job.stage === step}
            canRerun={canRerun}
            pending={retry.isPending}
            onRerun={() => retry.mutate({ from: step })}
          />
          {job.status === 'running' && job.stage === step && <Elapsed since={job.updatedAt} />}
        </div>
      ))}
    </div>
  )
}

/**
 * 这一步跑了多久。一次 LLM 调用要一两分钟且中途没有任何事件，
 * 不显示秒数的话「在跑」和「卡死」在页面上长得一样。
 */
function Elapsed(props: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [props.since])

  const sec = Math.max(0, Math.round((now - props.since) / 1000))
  return (
    <span className="text-muted-foreground ml-1.5 font-mono text-[11px] tabular-nums">
      {sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`}
    </span>
  )
}

const ICONS: Record<StepStatus, LucideIcon> = {
  pending: ChevronsRight,
  running: Loader2,
  done: Check,
  reused: RotateCcw,
  skipped: Minus,
  failed: X,
}

const TONES: Record<StepStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-brand/15 text-brand-ink',
  done: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  reused: 'bg-emerald-500/10 text-emerald-700/70 dark:text-emerald-400/70',
  skipped: 'bg-muted text-muted-foreground/60',
  failed: 'bg-destructive/15 text-destructive',
}

function Dot(props: {
  step: PipelineStep
  record: JobStep | null
  current: boolean
  canRerun: boolean
  pending: boolean
  onRerun: () => void
}) {
  // 库里没有这一步的记录（老任务，或还没轮到它）就按「未开始」画。
  const status: StepStatus = props.record?.status ?? (props.current ? 'running' : 'pending')
  const Icon = ICONS[status]
  const label = JOB_STAGE_LABEL[props.step]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={!props.canRerun || props.pending}
          onClick={props.onRerun}
          aria-label={`${label}：${STEP_STATUS_LABEL[status]}${props.canRerun ? '，点击从这一步重跑' : ''}`}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-full transition-transform',
            TONES[status],
            props.canRerun && 'hover:ring-brand-ink cursor-pointer hover:ring-2',
          )}
        >
          <Icon className={cn('size-3.5', status === 'running' && 'motion-safe:animate-spin')} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-medium">
          {label} · {STEP_STATUS_LABEL[status]}
        </p>
        {props.record?.note != null && <p className="max-w-[280px]">{props.record.note}</p>}
        {props.canRerun && <p className="text-muted-foreground">点击从这一步重跑</p>}
      </TooltipContent>
    </Tooltip>
  )
}
