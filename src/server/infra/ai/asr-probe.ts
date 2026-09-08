import type { ProbeResult } from '#shared/contract/probe.ts'
import type { AsrConfig } from '#shared/contract/config.ts'
import { classifyProbe, networkProbe, notConfigured, probeOk } from '../../domain/ai-probe.ts'
import type { Clock } from '../../ports/clock.ts'
import type { CommandRunner } from '../../ports/command.ts'
import { joinUrl } from './openai-compat.ts'

export interface AsrProbeDeps {
  fetch: typeof fetch
  clock: Clock
  config: () => AsrConfig
  apiKey: () => string | null
  /** null = 本进程没接命令探测，mlx-whisper 那条路只能报未配置。 */
  commands: CommandRunner | null
}

const TIMEOUT_MS = 15_000

/**
 * ASR 的连通性测试。两种 provider 的「最小请求」根本不是一回事：
 * openai-compat 是一次 HTTP，mlx-whisper 是看本地 PATH 上有没有那个可执行文件。
 */
export function makeAsrProbe(deps: AsrProbeDeps): () => Promise<ProbeResult> {
  return async () => {
    const cfg = deps.config()
    return cfg.provider === 'mlx-whisper' ? await probeLocal(deps) : await probeHttp(deps, cfg)
  }
}

async function probeLocal(deps: AsrProbeDeps): Promise<ProbeResult> {
  if (deps.commands === null) return notConfigured('本地命令探测（这个进程没接）')
  const started = deps.clock.now()
  const res = await deps.commands.probe('mlx_whisper', ['--help'])
  const ms = deps.clock.now() - started
  if (res.found) return probeOk(ms)
  // not-configured 而不是 network：没装东西不是网络问题，给的处置也不一样。
  return {
    ...notConfigured(`本机的 mlx_whisper（${res.detail}）。装它：uv tool install mlx-whisper`),
    ms,
  }
}

/**
 * 转写接口没有「空请求」这种东西，所以拿 `/models` 当最小请求 —— 它足够区分
 * 连不上和鉴权失败这两种，而 model 名错不错要等真跑一条音频才知道。
 */
async function probeHttp(deps: AsrProbeDeps, cfg: AsrConfig): Promise<ProbeResult> {
  if (cfg.baseURL.trim() === '') return notConfigured('baseURL')
  const key = deps.apiKey()
  const started = deps.clock.now()
  try {
    const res = await deps.fetch(joinUrl(cfg.baseURL, '/models'), {
      headers: key === null ? {} : { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await res.text()
    const ms = deps.clock.now() - started
    if (res.ok) return probeOk(ms)
    const { stage, detail } = classifyProbe(res.status, body)
    return { ok: false, ms, stage, detail }
  } catch (err) {
    return networkProbe(err, deps.clock.now() - started)
  }
}
