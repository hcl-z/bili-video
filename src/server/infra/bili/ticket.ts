import { createHmac } from 'node:crypto'
import { z } from 'zod'

import { fail, ok, type Result } from '#shared/contract/failure.ts'
import { shapeFailure } from '../../domain/bili-error.ts'

import { keyFromUrl, type WbiKeys } from './wbi.ts'

/**
 * `bili_ticket` 是带 TTL 的 Web 凭据；命中 -352 时需重取。
 * keyId 与 hmacKey 是公开 JS 常量，配置而非 secrets；不写死以避免错误导致静默换取失败。
 */

export const TICKET_URL =
  'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket'

export interface TicketKeys {
  keyId: string
  hmacKey: string
}

export interface WebTicket {
  ticket: string
  /** 到期时刻（epoch ms）。快到了就提前换，别等 401。 */
  expiresAt: number
  /** 同一响应里顺带回的 WBI key；没有就是 null，调用方再去打 nav。 */
  keys: WbiKeys | null
}

/** HMAC-SHA256(hmacKey, "ts" + ts) 的十六进制。 */
export function ticketHexSign(hmacKey: string, tsSec: number): string {
  return createHmac('sha256', hmacKey).update(`ts${tsSec}`).digest('hex')
}

/** 换 ticket 的表单体。未登录时 csrf 传空串（这个接口允许，但字段不能少）。 */
export function ticketFormBody(keys: TicketKeys, tsSec: number, csrf: string): string {
  if (keys.keyId === '' || keys.hmacKey === '') {
    throw new Error('bili_ticket 的 key 未配置（config.bili.ticket），无法换取 ticket')
  }
  return new URLSearchParams({
    key_id: keys.keyId,
    hexsign: ticketHexSign(keys.hmacKey, tsSec),
    'context[ts]': String(tsSec),
    csrf,
  }).toString()
}

const TicketDataSchema = z.object({
  ticket: z.string().min(1),
  ttl: z.number().int().positive(),
  nav: z
    .object({
      img: z.object({ img_url: z.string() }).optional(),
      sub: z.object({ sub_url: z.string() }).optional(),
    })
    .optional(),
})

/** 解析 `data` 段。形状不对是 fatal —— 接口变了，重试不会让它变回来。 */
export function parseTicketResponse(data: unknown, now: number): Result<WebTicket> {
  const parsed = TicketDataSchema.safeParse(data)
  if (!parsed.success) return fail(shapeFailure('bili_ticket', data))
  const { ticket, ttl, nav } = parsed.data
  const imgUrl = nav?.img?.img_url
  const subUrl = nav?.sub?.sub_url
  return ok({
    ticket,
    expiresAt: now + ttl * 1000,
    keys:
      imgUrl !== undefined && subUrl !== undefined
        ? { imgKey: keyFromUrl(imgUrl), subKey: keyFromUrl(subUrl), fetchedAt: now }
        : null,
  })
}
