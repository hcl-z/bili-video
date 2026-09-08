import { countTokens } from 'gpt-tokenizer'

/** token 计数，domain 里唯一的外部依赖。cl100k 的表对国产模型只是近似，够用来判断该不该分段。 */
export function tokensOf(text: string): number {
  return text === '' ? 0 : countTokens(text)
}
