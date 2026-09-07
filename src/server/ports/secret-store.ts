/**
 * SESSDATA、cookie、AI apiKey 都走这里，加密落库（AES-256-GCM + scrypt）。
 *
 * get() 返回明文是有意的：服务端要拿它去调 B 站和 LLM。「读取永远返回掩码」这条约束
 * 落在 HTTP 层 —— API 只吐 describe() 的结果，表单是 write-only（提交空值表示不修改）。
 */
export interface SecretStore {
  get(key: SecretKey): string | null
  set(key: SecretKey, value: string): void
  delete(key: SecretKey): void
  has(key: SecretKey): boolean
  /** 给页面看的安全形态：只有掩码和长度，没有明文。 */
  describe(key: SecretKey): SecretDescription | null
  /** 已存在的 key 列表（不含值）。 */
  keys(): SecretKey[]
}

export type SecretKey = string

export interface SecretDescription {
  key: SecretKey
  /** 形如 `ab****yz`。 */
  masked: string
  length: number
  updatedAt: number
}
