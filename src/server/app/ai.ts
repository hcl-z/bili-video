import type {
  AiSettingsResponse,
  AiTestResponse,
  PatchAiSettingsRequest,
  SecretState,
} from '#shared/contract/api.ts'
import { AiConfigSchema, AsrConfigSchema } from '#shared/contract/config.ts'
import type { ProbeResult } from '#shared/contract/probe.ts'
import { secretWrite } from '../domain/secret-write.ts'
import type { ConfigStore } from '../ports/config-store.ts'
import type { EventBus } from '../ports/event-bus.ts'
import type { Llm } from '../ports/llm.ts'
import type { Logger } from '../ports/logger.ts'
import type { SecretKey, SecretStore } from '../ports/secret-store.ts'

/** apiKey 的两个 secrets 表键名。写死在一处，免得读写两边各拼一遍。 */
export const LLM_API_KEY: SecretKey = 'llm-api-key'
export const ASR_API_KEY: SecretKey = 'asr-api-key'

export interface AiDeps {
  config: ConfigStore
  secrets: SecretStore
  events: EventBus
  logger: Logger
  llm: Llm | null
  probeAsr: (() => Promise<ProbeResult>) | null
}

export class AiService {
  private readonly deps: AiDeps
  private readonly logger: Logger

  constructor(deps: AiDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'ai' })
  }

  /**
   * ★ 取 LLM 的唯一入口。总开关关着就是 null。
   *
   * 后续流程（字幕、总结、推送）只能从这里拿 LLM，于是「关掉开关就一次都不调」
   * 由类型保证，而不是靠每个调用点自己记得先查一下开关。
   */
  llm(): Llm | null {
    if (!this.deps.config.getSection('ai').enabled) return null
    return this.deps.llm
  }

  settings(): AiSettingsResponse {
    return {
      ai: this.deps.config.getSection('ai'),
      asr: this.deps.config.getSection('asr'),
      llmKey: this.describe(LLM_API_KEY),
      asrKey: this.describe(ASR_API_KEY),
    }
  }

  /** 配置段与 apiKey 一起改。写库即热生效，不重启。 */
  patch(patch: PatchAiSettingsRequest): AiSettingsResponse {
    if (patch.ai !== undefined) {
      const merged = AiConfigSchema.parse({ ...this.deps.config.getSection('ai'), ...patch.ai })
      this.deps.config.setSection('ai', merged)
      this.deps.events.emit({ type: 'config.changed', section: 'ai' })
    }
    if (patch.asr !== undefined) {
      const merged = AsrConfigSchema.parse({ ...this.deps.config.getSection('asr'), ...patch.asr })
      this.deps.config.setSection('asr', merged)
      this.deps.events.emit({ type: 'config.changed', section: 'asr' })
    }

    this.applyKey(LLM_API_KEY, patch.llmApiKey)
    this.applyKey(ASR_API_KEY, patch.asrApiKey)
    return this.settings()
  }

  /** 两个探测并发跑：一个卡到超时不该让另一个也干等着。两边都不抛，各自把失败当值返回。 */
  async test(): Promise<AiTestResponse> {
    const [llm, asr] = await Promise.all([
      this.deps.llm?.ping() ?? notWired('LLM'),
      this.deps.probeAsr?.() ?? notWired('ASR'),
    ])
    this.logger.info({ llm: llm.ok, asr: asr.ok, llmMs: llm.ms, asrMs: asr.ms }, '连通性测试完成')
    return { llm, asr }
  }

  private applyKey(key: SecretKey, input: string | null | undefined): void {
    const write = secretWrite(input, this.deps.secrets.describe(key)?.masked ?? null)
    if (write.action === 'keep') return
    if (write.action === 'clear') {
      this.deps.secrets.delete(key)
      this.logger.info({ key }, 'apiKey 已清空')
      return
    }
    this.deps.secrets.set(key, write.value)
    this.logger.info({ key }, 'apiKey 已更新')
  }

  private describe(key: SecretKey): SecretState {
    const d = this.deps.secrets.describe(key)
    if (d === null) return { configured: false, masked: null, updatedAt: null }
    return { configured: true, masked: d.masked, updatedAt: d.updatedAt }
  }
}

const notWired = (what: string): Promise<ProbeResult> =>
  Promise.resolve({
    ok: false,
    ms: 0,
    stage: 'not-configured',
    detail: `${what} 适配器没接入这个进程`,
  })
