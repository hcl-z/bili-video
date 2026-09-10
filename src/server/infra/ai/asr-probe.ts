import type { ProbeResult } from '#shared/contract/probe.ts'
import type { AsrConfig } from '#shared/contract/config.ts'
import { classifyProbe, networkProbe, notConfigured, probeOk } from '../../domain/ai-probe.ts'
import type { Clock } from '../../types/platform.ts'
import type { CommandRunner } from '../../types/platform.ts'
import { joinUrl } from './openai-compat.ts'

export interface AsrProbeDeps {
  fetch: typeof fetch
  clock: Clock
  config: () => AsrConfig
  apiKey: () => string | null
  /** null = 本进程没接命令探测，mlx-audio 应项路只能报未配置 */
  commands: CommandRunner | null
}

const TIMEOUT_MS = 15_000

/** ASR 的连通性测试。两种 provider 的「最小请求」根本不是一回事： openai-compat 是一次 HTTP，mlx-audio 是看本地 Python 模块能不能启动 */
export function makeAsrProbe(deps: AsrProbeDeps): () => Promise<ProbeResult> {
  return async () => {
    const cfg = deps.config()
    return cfg.provider === 'mlx-audio' ? await probeLocal(deps) : await probeHttp(deps, cfg)
  }
}

async function probeLocal(deps: AsrProbeDeps): Promise<ProbeResult> {
  if (deps.commands === null) return notConfigured('本地命令探测（这个进程没接）')
  const started = deps.clock.now()
  try {
    const res = await deps.commands.run(
      'python3',
      ['-m', 'mlx_audio.stt.generate', '--help'],
      { timeoutMs: TIMEOUT_MS },
    )
    const ms = deps.clock.now() - started
    if (res.code === 0) return probeOk(ms)
    const detail = (res.stderr || res.stdout).trim().split('\n').at(-1) ?? '启动失败'
    return { ...notConfigured(`本机的 mlx_audio（${detail}）。装它：uv pip install mlx-audio`), ms }
  } catch (err) {
    return {
      ...notConfigured(`本机的 mlx_audio（${err instanceof Error ? err.message : String(err)}）`),
      ms: deps.clock.now() - started,
    }
  }
}

/**
 * 转写接口没有「空请求」这种东西，所以拿 `/models` 当最小请求 —— 它足够区分
 * 连不上和鉴权失败这两种，而 model 名错不错要等真跑一条音频才知道。
 */
async function probeHttp(deps: AsrProbeDeps, cfg: AsrConfig): Promise<ProbeResult> {
  if (cfg.baseURL.trim() === '') return notConfigured('baseURL')
  const key = deps.apiKey()
  const url = joinUrl(cfg.baseURL, '/models')
  const started = deps.clock.now()
  try {
    const res = await deps.fetch(url, {
      headers: key === null ? {} : { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await res.text()
    const ms = deps.clock.now() - started
    if (res.ok) return probeOk(ms)
    // 地址跟着一起给：baseURL 少个 /v1 是这里最常见的错，不写出来看不出来。
    const { stage, detail } = classifyProbe(res.status, body)
    return { ok: false, ms, stage, detail: `${detail}｜请求的是 ${url}` }
  } catch (err) {
    const res = networkProbe(err, deps.clock.now() - started)
    return { ...res, detail: `${res.detail ?? ''}｜请求的是 ${url}` }
  }
}
