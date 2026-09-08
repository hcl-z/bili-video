/** 越过失败项推进锚点就等于永久丢掉它，所以锚点卡在「本 UP 最早失败项」之前。 */
export interface AnchorItem {
  uid: string
  pubTs: number
  ok: boolean
}

/** @returns 只包含真的要往前挪的 uid。 */
export function nextAnchors(
  items: readonly AnchorItem[],
  current: ReadonlyMap<string, number>,
): Map<string, number> {
  const next = new Map<string, number>()

  for (const uid of new Set(items.map((i) => i.uid))) {
    const mine = items.filter((i) => i.uid === uid)
    const failures = mine.filter((i) => !i.ok).map((i) => i.pubTs)
    const barrier = failures.length > 0 ? Math.min(...failures) : Infinity

    const reached = mine
      .filter((i) => i.ok && i.pubTs < barrier)
      .reduce((max, i) => Math.max(max, i.pubTs), -Infinity)
    if (reached === -Infinity) continue

    const now = current.get(uid)
    if (now === undefined || reached > now) next.set(uid, reached)
  }
  return next
}
