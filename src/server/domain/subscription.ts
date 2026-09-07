/**
 * 订阅相关的纯判断。零 IO —— 「粘进来的这串东西是哪个 uid」和「这个关系值算不算已关注」
 * 都是会被反复怀疑的规则，放在这里才能单独钉住。
 */

/** 空间页链接：桌面版 `space.bilibili.com/<uid>`，移动版 `m.bilibili.com/space/<uid>`。 */
const SPACE_PATTERNS = [/space\.bilibili\.com\/(\d{1,12})/, /bilibili\.com\/space\/(\d{1,12})/]
/** 光秃秃的一串数字，或者从 App 里复制来的 `UID:12345`。 */
const BARE_UID = /^(?:uid[:：]?)?\s*(\d{1,12})$/i

/**
 * 从「用户粘进来的任意一串东西」里认出 uid。
 *
 * 分享出来的文本往往是「【某某的个人空间】https://space.bilibili.com/123 ...」这种一整段，
 * 所以先在全文里找空间链接，再退回「整段就是一个 uid」。认不出来返回 null，
 * 绝不猜 —— 猜错会去关注一个陌生人。
 */
export function parseUid(input: string): string | null {
  const text = input.trim()
  if (text === '') return null

  for (const re of SPACE_PATTERNS) {
    const m = re.exec(text)
    if (m?.[1] !== undefined) return normalize(m[1])
  }

  const bare = BARE_UID.exec(text)
  if (bare?.[1] !== undefined) return normalize(bare[1])

  return null
}

/** 去掉前导零，顺手挡掉 uid 0。 */
function normalize(digits: string): string | null {
  const uid = String(Number(digits))
  return uid === '0' ? null : uid
}

/**
 * `x/relation/relations` 给的 attribute → 算不算已关注。
 *
 * 0 未关注、1 悄悄关注、2 已关注、6 互相关注、128 已拉黑。
 * 悄悄关注也算：它一样进关注列表、一样出现在聚合流里，再关注一次是白发一个写请求。
 */
export function isFollowing(attribute: number): boolean {
  return attribute === 1 || attribute === 2 || attribute === 6
}
