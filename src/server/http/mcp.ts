import * as z from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import { PIPELINE_STEPS, type PipelineStep } from '#shared/contract/job.ts'
import type { ManualParseService } from '../app/manual-parse.ts'
import type { QueueDeps } from '../app/queue-runner.ts'
import { failureFields } from '../log-fields.ts'
import type { SummaryQueue } from '../app/queue-runner.ts'
import type { ServerDeps } from '../types/index.ts'

/**
 * 暴露的是**队列本身**，不是另起一套解析：MCP 排进来的任务和轮询抓到的走同一条流水线、
 * 同一个并发额度、同一份重试预算。另开一条路会让两边的限流各算各的。
 */

export interface McpDeps {
  queue: SummaryQueue
  manual: ManualParseService
  deps: ServerDeps
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const
const mutating = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const

const bvid = z.string().regex(/^BV[0-9A-Za-z]{10}$/).describe('BV 号')

function text(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { data },
  }
}

/** 失败是值：把 kind 一起给出去，客户端才知道该不该重试。 */
function failed(failure: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: 'FAILED', failure }, null, 2) }],
  }
}

function crashed(err: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          { error: 'TOOL_ERROR', message: err instanceof Error ? err.message : String(err) },
          null,
          2,
        ),
      },
    ],
  }
}

/** 任务详情：把步骤也带上，一次调用就能看出卡在哪一步。 */
const jobView = (
  deps: ServerDeps,
  job: { id: number; bvid: string; updateId: string; want: string; status: string; stage: string; error: string | null; retries: number },
) => {
  const update = deps.repos.updates.get(job.updateId)
  const summary = deps.repos.summaries.get(job.bvid)
  return {
    id: job.id,
    bvid: job.bvid,
    status: job.status,
    stage: job.stage,
    error: job.error,
    retries: job.retries,
    title: update?.title ?? null,
    filtered: update?.filtered ?? null,
    hasSummary: summary !== null,
    want: job.want,
    transcriptSource: summary?.transcriptSource ?? null,
    degradePath: summary?.degradePath ?? null,
    steps: deps.repos.jobs.get(job.id)?.steps ?? [],
  }
}

export function registerMcpTools(server: McpServer, d: McpDeps): void {
  const { deps, queue, manual } = d

  server.registerTool(
    'bili_parse_video',
    {
      description:
        '把指定 BV 号排进队列，取字幕或语音转写。只要转写数据，不调 AI。立刻返回任务 id，不等完成。已有任务时复用，force=true 才会作废重跑。',
      inputSchema: {
        bvid,
        force: z.boolean().optional().describe('true = 作废已有任务并从头重跑'),
      },
      annotations: mutating,
    },
    async (args) => {
      try {
        // 只取转写不碰 LLM，所以不看 AI 总开关
        const res = await manual.parse(args.bvid, {
          want: 'transcript',
          ...(args.force === undefined ? {} : { force: args.force }),
        })
        if (!res.ok) {
          deps.logger.warn({ bvid: args.bvid, ...failureFields(res.failure) }, 'MCP 排解析失败')
          return failed(res.failure)
        }
        return text({ outcome: res.value.kind, job: jobView(deps, res.value.job) })
      } catch (err) {
        return crashed(err)
      }
    },
  )

  server.registerTool(
    'bili_job_status',
    {
      description:
        '查一条视频的解析进度：任务状态、当前步骤、每步结果、有没有生成总结。bvid 没排过时返回 notFound。',
      inputSchema: { bvid },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const item = manual.status(args.bvid)
        if (!item.ok) return text({ bvid: args.bvid, notFound: true, message: item.failure.message })
        const job = deps.repos.jobs.getByBvid(args.bvid)
        return text({
          bvid: args.bvid,
          state: item.value.state,
          title: item.value.title,
          summaryState: item.value.degradePath,
          job: job === null ? null : jobView(deps, job),
        })
      } catch (err) {
        return crashed(err)
      }
    },
  )

  server.registerTool(
    'bili_queue_list',
    {
      description: '列出队列里的任务，按状态过滤。默认最近 50 条。',
      inputSchema: {
        status: z.enum(['pending', 'running', 'done', 'failed']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const jobs = deps.repos.jobs.list({
          limit: args.limit ?? 50,
          ...(args.status === undefined ? {} : { status: args.status }),
        })
        return text({
          counts: deps.repos.jobs.counts(),
          jobs: jobs.map((j) => jobView(deps, j)),
        })
      } catch (err) {
        return crashed(err)
      }
    },
  )

  server.registerTool(
    'bili_retry_job',
    {
      description:
        '重跑一条任务。from 指定从哪一步起跑（那一步之前的产物照用）；不传就从头来。',
      inputSchema: {
        bvid,
        from: z.enum(PIPELINE_STEPS as [PipelineStep, ...PipelineStep[]]).optional(),
      },
      annotations: mutating,
    },
    async (args) => {
      try {
        const job = deps.repos.jobs.getByBvid(args.bvid)
        if (job === null) return text({ bvid: args.bvid, notFound: true })
        const res = queue.retry(job.id, args.from)
        if (res === 'busy') return failed({ kind: 'fatal', code: null, message: '这条任务正在队列里，不用重跑', retryAfterMs: null })
        const after = deps.repos.jobs.get(job.id)
        return text({ outcome: 'ok', job: after === null ? null : jobView(deps, after) })
      } catch (err) {
        return crashed(err)
      }
    },
  )

  server.registerTool(
    'bili_transcript',
    {
      description:
        '取已拿到的字幕/转写文本。这是主产物：带时间戳的纯文本 + 原始 cues。source 说明来自官方字幕还是语音转写。',
      inputSchema: {
        bvid,
        format: z
          .enum(['text', 'cues', 'both'])
          .optional()
          .describe('text=带时间戳的纯文本（默认）；cues=逐条时间轴；both=两者都给'),
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const res = manual.transcript(args.bvid)
        if (!res.ok) return failed(res.failure)
        if (res.value === null) {
          const job = deps.repos.jobs.getByBvid(args.bvid)
          return text({
            bvid: args.bvid,
            hasTranscript: false,
            hint: job === null ? '还没排过，先调 bili_parse_video' : `任务状态：${job.status}/${job.stage}`,
          })
        }
        const t = res.value
        const format = args.format ?? 'text'
        return text({
          bvid: t.bvid,
          hasTranscript: true,
          source: t.source,
          cueCount: t.cueCount,
          idleReasons: t.reasons,
          ...(format === 'cues' ? { cues: t.cues } : {}),
          ...(format === 'text' ? { text: t.text } : {}),
          ...(format === 'both' ? { text: t.text, cues: t.cues } : {}),
        })
      } catch (err) {
        return crashed(err)
      }
    },
  )

  server.registerTool(
    'bili_summarize',
    {
      description:
        '可选：对已有转写再生成 AI 总结。转写产物会被直接复用，不重新取字幕、不重新转写。',
      inputSchema: {
        bvid,
        force: z.boolean().optional().describe('true = 丢掉已有的总结正文，重新调 LLM'),
      },
      annotations: mutating,
    },
    async (args) => {
      if (!deps.config.getSection('ai').enabled) {
        return failed({ kind: 'fatal', code: null, message: 'AI 总开关关着，打开后才能生成总结', retryAfterMs: null })
      }
      try {
        const transcript = manual.transcript(args.bvid)
        if (!transcript.ok) return failed(transcript.failure)
        if (transcript.value === null) {
          return text({ bvid: args.bvid, started: false, reason: '还没有转写，先调 bili_parse_video' })
        }
        // 从 chunk 起跑：subtitle/download/asr 三步的产物都还在，直接复用
        const res = await manual.parse(args.bvid, {
          want: 'summary',
          ...(args.force === true ? { force: true } : {}),
        })
        if (!res.ok) return failed(res.failure)
        return text({ started: true, outcome: res.value.kind, job: jobView(deps, res.value.job) })
      } catch (err) {
        return crashed(err)
      }
    },
  )

  server.registerTool(
    'bili_summary',
    {
      description:
        '取已生成的 AI 总结正文。总结是可选的，没有时用 bili_summarize 触发。',
      inputSchema: {
        bvid,
      },
      annotations: readOnly,
    },
    async (args) => {
      try {
        const summary = deps.repos.summaries.get(args.bvid)
        if (summary === null) return text({ bvid: args.bvid, hasSummary: false })
        return text({
          bvid: args.bvid,
          hasSummary: true,
          title: deps.repos.updates.getByBvid(args.bvid)?.title ?? null,
          tldr: summary.tldr,
          article: summary.article,
          transcriptSource: summary.transcriptSource,
          degradePath: summary.degradePath,
          createdAt: summary.createdAt,
        })
      } catch (err) {
        return crashed(err)
      }
    },
  )
}

export interface McpRouteOptions {
  deps: McpDeps
  /** 挂载路径，默认 /api/mcp */
  path: string
}

/**
 * Streamable HTTP，无状态模式：每个请求现建 server + transport，不保留会话。
 * 这个服务只监听回环地址，没有鉴权 —— 对外暴露等于把账号和推送渠道一起给出去。
 */
export function createMcpFetchHandler(opts: McpRouteOptions): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const server = new McpServer({ name: 'bili-video', version: '0.1.0' })
    registerMcpTools(server, opts.deps)

    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    })
    await server.connect(transport)
    try {
      return await transport.handleRequest(req)
    } finally {
      // 响应体是流式返回的，等它读完再收尾会把连接关掉；交给 GC 与进程退出处理。
      void transport.close()
      void server.close()
    }
  }
}

export type { QueueDeps }
