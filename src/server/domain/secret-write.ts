/** 表单是 write-only，所以「用户想干什么」只能从值本身推： 缺省或空串 = 没动这个框，null = 明确要清空，其余 = 写新值。 还要挡住掩码回传：页面若把 `sk-1****9abc` 原样发回来，当成新 apiKey 存下去 就等于用一串星号覆盖了真 key，而且要等到下次调模型才会发现 */
export type SecretWrite = { action: 'keep' } | { action: 'clear' } | { action: 'set'; value: string }

export function secretWrite(
  input: string | null | undefined,
  currentMasked: string | null,
): SecretWrite {
  if (input === undefined) return { action: 'keep' }
  if (input === null) return { action: 'clear' }
  const value = input.trim()
  if (value === '') return { action: 'keep' }
  if (currentMasked !== null && value === currentMasked) return { action: 'keep' }
  // 没存过 key 时也挡：任何一串「几个字符 + 连续星号 + 几个字符」都不可能是真 apiKey
  if (/^.{1,8}\*{2,}.{1,8}$/.test(value)) return { action: 'keep' }
  return { action: 'set', value }
}
