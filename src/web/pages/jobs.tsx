import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Loader2, RotateCcw } from 'lucide-react'

import type { JobsResponse } from '#shared/contract/api.ts'
import type { SummaryJob } from '#shared/contract/job.ts'
import { JOB_STAGE_LABEL } from '#shared/contract/job.ts'
import { videoUrl } from '#shared/format.ts'
import { JobPipeline } from '@/components/job-pipeline'
import { Page } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatTime } from '@/lib/format'
import { keys } from '@/lib/query'
import { useRetryJob } from '@/lib/use-retry-job'

const GROUPS: ReadonlyArray<[SummaryJob['status'], string]> = [
  ['running', '进行中'],
  ['pending', '待处理'],
  ['failed', '失败'],
  ['done', '已完成'],
]

export function JobsPage() {
  const jobs = useQuery({ queryKey: keys.jobs, queryFn: api.jobs })

  return (
    <Page
      title="队列"
      hint="六步流水线：每一步的状态一眼看到，点某一步就从那儿重跑，前面的结果不重复跑。"
    >
      {jobs.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : jobs.isError ? (
        <p className="text-destructive text-sm">{jobs.error.message}</p>
      ) : jobs.data.jobs.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            还没有任务。抓到开了 AI 总结的 UP 主发的视频后，这里会自动排上。
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {GROUPS.map(([status, title]) => (
            <Group
              key={status}
              title={title}
              jobs={jobs.data.jobs.filter((j) => j.status === status)}
              videos={jobs.data.videos}
            />
          ))}
        </div>
      )}
    </Page>
  )
}

function Group(props: { title: string; jobs: SummaryJob[]; videos: JobsResponse['videos'] }) {
  if (props.jobs.length === 0) return null
  return (
    <section>
      <h2 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide">
        {props.title} · {props.jobs.length}
      </h2>
      <div className="space-y-2">
        {props.jobs.map((job) => (
          <JobRow key={job.id} job={job} video={props.videos[job.bvid]} />
        ))}
      </div>
    </section>
  )
}

function JobRow(props: { job: SummaryJob; video: { title: string; url: string } | undefined }) {
  const { job } = props
  const retry = useRetryJob(job.id)

  return (
    <Card>
      <CardContent className="py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <a
              href={props.video?.url ?? videoUrl(job.bvid)}
              target="_blank"
              rel="noreferrer"
              className="line-clamp-1 text-sm font-medium hover:underline"
            >
              {props.video?.title ?? job.bvid}
            </a>
            <div className="text-muted-foreground mt-1.5 flex items-center gap-2 text-xs">
              <StageBadge job={job} />
              <span className="font-mono">{job.bvid}</span>
              <span>·</span>
              <span>{formatTime(job.updatedAt)}</span>
              {job.attempts > 1 && <span>· 第 {job.attempts} 次</span>}
            </div>
          </div>

          {/* 跑着的不给重跑按钮：点了也只会被后端挡回来。 */}
          {job.status !== 'running' && job.status !== 'pending' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => retry.mutate({})}
              disabled={retry.isPending}
            >
              <RotateCcw className="size-3.5" />
              整条重跑
            </Button>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <JobPipeline job={job} />
          <p className="text-muted-foreground text-xs">点某一步从那儿重跑，前面的结果直接复用</p>
        </div>

        {job.error !== null && (
          <p className="bg-muted/60 mt-2.5 rounded px-2 py-1.5 text-xs">{job.error}</p>
        )}
      </CardContent>
    </Card>
  )
}

function StageBadge(props: { job: SummaryJob }) {
  const { job } = props
  if (job.status === 'running') {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="size-3 animate-spin" />
        {JOB_STAGE_LABEL[job.stage]}
      </Badge>
    )
  }
  if (job.status === 'failed') return <Badge variant="destructive">卡在{JOB_STAGE_LABEL[job.stage]}</Badge>
  if (job.status === 'done') {
    return (
      <Badge variant="outline" className="gap-1">
        <CheckCircle2 className="size-3" />
        已完成
      </Badge>
    )
  }
  return <Badge variant="outline">{JOB_STAGE_LABEL[job.stage]}</Badge>
}
