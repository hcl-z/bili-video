import type { ReaderItem } from '#shared/contract/api.ts'
import type { Update } from '#shared/contract/update.ts'
import { readerItem } from '../domain/summary-format.ts'
import type { Ports } from '../ports/index.ts'

/**
 * 本地库的一行 → 阅读页一行。
 *
 * 简介与多图库里没存（轮询只拿它们做过滤判定），所以这条路径上它们是空的 ——
 * 要看完整的原动态就走 UP 泳道，那边是现拉的。
 */
export function fromUpdate(ports: Ports, u: Update): ReaderItem {
  const { summaries, jobs } = ports.repos
  return readerItem(
    {
      dynId: u.dynId,
      uid: u.uid,
      type: u.type,
      pubTs: u.pubTs,
      title: u.title,
      text: u.text,
      desc: null,
      cover: u.cover,
      pics: [],
      bvid: u.bvid,
      url: u.url,
    },
    {
      update: u,
      summary: u.bvid === null ? null : summaries.get(u.bvid),
      job: u.bvid === null ? null : jobs.getByBvid(u.bvid),
    },
  )
}
