import type { AsrConfig } from '#shared/contract/config.ts'
import type { Asr } from '../../ports/asr.ts'
import type { CommandRunner } from '../../ports/command.ts'
import type { Logger } from '../../ports/logger.ts'
import { ChatAudioAsr } from './chat-audio.ts'
import { MlxWhisperAsr } from './mlx-whisper.ts'
import { OpenAiCompatAsr } from './openai-compat.ts'

export interface AsrSwitchDeps {
  fetch: typeof fetch
  commands: CommandRunner
  logger: Logger
  config: () => AsrConfig
  apiKey: () => string | null
}

/**
 * provider 的切换点。编排层只认 `Asr`，改配置就换实现，不用重启也不用改 app。
 * 每次调用现读 provider，所以页面上切完下一条转写就走新的。
 */
export function makeAsr(deps: AsrSwitchDeps): Asr {
  const local = new MlxWhisperAsr({ commands: deps.commands, logger: deps.logger, config: deps.config })
  const cloud = new OpenAiCompatAsr({
    fetch: deps.fetch,
    logger: deps.logger,
    config: deps.config,
    apiKey: deps.apiKey,
  })
  const chat = new ChatAudioAsr({
    fetch: deps.fetch,
    commands: deps.commands,
    logger: deps.logger,
    config: deps.config,
    apiKey: deps.apiKey,
  })
  const pick = (): Asr => {
    switch (deps.config().provider) {
      case 'mlx-whisper':
        return local
      case 'chat-audio':
        return chat
      default:
        return cloud
    }
  }

  return {
    get provider() {
      return pick().provider
    },
    transcribe: (path, opts) => pick().transcribe(path, opts),
  }
}
