import { createHash } from 'node:crypto'

/** WBI 为读接口补 `wts` 和 `w_rid`；签名错误会触发 -352 风控并退避。 密钥取自 nav 的两个 32 字符文件名，64 项混淆表由配置注入，避免前端变更或配置错误造成静默失败 */

export interface WbiKeys {
  imgKey: string
  subKey: string
  /** 取回时刻。命中风控时要清空重取，调用方靠这个判断新旧 */
  fetchedAt: number
}

const MIXIN_LENGTH = 64
const MIXIN_KEY_LENGTH = 32


const STRIPPED = /[!'()*]/g

/** 把 `imgKey + subKey` 的 64 个字符按混淆表重排，取前 32 位当签名密钥 */
export function mixinKey(keys: WbiKeys, table: readonly number[]): string {
  const raw = keys.imgKey + keys.subKey
  if (raw.length !== MIXIN_LENGTH) {
    throw new Error(
      `WBI 密钥长度应为 ${MIXIN_LENGTH}（imgKey + subKey 各 32），实际 ${raw.length}：nav 响应格式可能变了`,
    )
  }
  if (table.length !== MIXIN_LENGTH) {
    throw new Error(`WBI 混淆表必须正好 ${MIXIN_LENGTH} 项，实际 ${table.length} 项`)
  }
  let out = ''
  for (const index of table) {
    out += raw[index] ?? ''
    if (out.length === MIXIN_KEY_LENGTH) break
  }
  return out
}

/**
 * 给一组参数补上 `wts` 与 `w_rid`。
 *
 * 返回的是**可以直接发出去**的参数表：值保持原样（未剔除特殊字符），
 * 只有参与 md5 的那份临时副本被剔除过。两者混淆会让签名对不上。
 */
export function signWbi(
  params: Record<string, string | number>,
  keys: WbiKeys,
  table: readonly number[],
  nowSec: number,
): Record<string, string> {
  if (table.length === 0) {
    throw new Error('WBI 混淆表未配置（config.bili.wbiMixinTable 为空），无法签名')
  }

  const signed: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) signed[key] = String(value)
  signed['wts'] = String(nowSec)

  // 按 key 升序拼串：B 站按排序后的 query 算摘要，顺序错了签名就错了。
  const query = new URLSearchParams(
    Object.keys(signed)
      .sort()
      .map((key) => [key, signed[key]!.replace(STRIPPED, '')] as [string, string]),
  ).toString()

  signed['w_rid'] = createHash('md5')
    .update(query + mixinKey(keys, table))
    .digest('hex')
  return signed
}

/** nav 响应里的 img_url/sub_url → 32 位 key（取文件名去后缀）。 */
export function keyFromUrl(url: string): string {
  const file = url.slice(url.lastIndexOf('/') + 1)
  const dot = file.lastIndexOf('.')
  return dot === -1 ? file : file.slice(0, dot)
}
