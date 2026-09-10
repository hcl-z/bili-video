import type { AsrProvider } from '#shared/contract/config.ts'

export class LocalAsrUnavailableError extends Error {
  constructor() {
    super('Docker 内只支持远程 ASR：openai-compat 或 chat-audio')
  }
}

export function assertAsrProviderAvailable(isDocker: boolean, provider: AsrProvider): void {
  if (isDocker && provider === 'mlx-audio') throw new LocalAsrUnavailableError()
}
