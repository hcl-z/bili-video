import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import type { UpdateWithRaw } from '#shared/contract/update.ts'
import { InMemoryEventBus } from '../src/server/infra/event-bus/in-memory.ts'
import { openCore, type Core } from '../src/server/wiring.ts'
import { FakeClock } from './fakes/clock.ts'
import { CollectingLogger } from './fakes/logger.ts'

/**
 * 这一票只装配仓储，不测业务流程 —— 但仓储里那些「靠 SQL 保证的不变量」
 * （锚点单调、dyn_id 去重、投递唯一）错了不会报错，只会在后面几票里表现成丢推送或重复推送，
 * 所以在这儿钉住。
 */
const dirs: string[] = []
function freshCore(): Core {
  const dir = mkdtempSync(join(tmpdir(), 'bili-video-repo-'))
  dirs.push(dir)
  return openCore({
    dataDir: dir,
    clock: new FakeClock(),
    logger: new CollectingLogger(),
    events: new InMemoryEventBus(),
  })
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function update(dynId: string, over: Partial<UpdateWithRaw> = {}): UpdateWithRaw {
  return {
    dynId,
    uid: '100',
    type: 'AV',
    pubTs: 1_000,
    title: '标题',
    text: null,
    cover: null,
    bvid: `BV${dynId}`,
    url: `https://t.bilibili.com/${dynId}`,
    filtered: false,
    filterReason: null,
    createdAt: 2_000,
    raw: { id: dynId },
    ...over,
  }
}

describe('subscriptions', () => {
  it('upsert 不会把已有的 followedAt 冲掉', () => {
    const c = freshCore()
    c.repos.subscriptions.upsert({
      uid: '100',
      name: '甲',
      face: null,
      enableDynamic: true,
      enableVideo: true,
      enableAi: true,
    })
    c.repos.subscriptions.markFollowed('100', 5_000)

    // 后续同步只带来新的昵称/头像，不该顺手把「已关注」抹掉。
    c.repos.subscriptions.upsert({
      uid: '100',
      name: '甲改名了',
      face: 'https://x/a.jpg',
      enableDynamic: false,
      enableVideo: true,
      enableAi: true,
    })

    const sub = c.repos.subscriptions.get('100')
    assert.equal(sub?.name, '甲改名了')
    assert.equal(sub?.enableDynamic, false)
    assert.equal(sub?.followedAt, 5_000, 'followedAt 必须保留')
    c.close()
  })

  it('规则按 scope 生效：global 加上该 uid 自己的', () => {
    const c = freshCore()
    c.repos.rules.add({ scope: 'global', kind: 'keyword-deny', pattern: '广告', enabled: true })
    c.repos.rules.add({ scope: '100', kind: 'keyword-allow', pattern: '教程', enabled: true })
    c.repos.rules.add({ scope: '200', kind: 'keyword-allow', pattern: '别人的', enabled: true })

    assert.deepEqual(
      c.repos.rules.listEffective('100').map((r) => r.pattern).sort(),
      ['广告', '教程'],
    )
    assert.equal(c.repos.rules.list().length, 3)
    c.close()
  })
})

describe('anchors', () => {
  it('只单调推进，回退的时间戳被忽略', () => {
    const c = freshCore()
    c.repos.anchors.advance('100', 1_000, 1)
    assert.equal(c.repos.anchors.get('100'), 1_000)

    c.repos.anchors.advance('100', 2_000, 2)
    assert.equal(c.repos.anchors.get('100'), 2_000)

    // B 站偶尔会把置顶的老动态排在前面。锚点若跟着回退，那批动态会被重推一遍。
    c.repos.anchors.advance('100', 500, 3)
    assert.equal(c.repos.anchors.get('100'), 2_000, '锚点不能回退')

    assert.equal(c.repos.anchors.get('999'), null)
    assert.deepEqual([...c.repos.anchors.getAll()], [['100', 2_000]])
    c.close()
  })
})

describe('updates', () => {
  it('dyn_id 去重：重复轮询同一批不会重复入库', () => {
    const c = freshCore()
    const first = c.repos.updates.insertMany([update('a'), update('b')])
    assert.deepEqual(first, { inserted: ['a', 'b'], skipped: [] })

    const second = c.repos.updates.insertMany([update('b'), update('c')])
    assert.deepEqual(second, { inserted: ['c'], skipped: ['b'] })

    assert.equal(c.repos.updates.list({ limit: 10 }).length, 3)
    c.close()
  })

  it('被过滤的动态默认不出现在列表里，但仍然入库', () => {
    const c = freshCore()
    c.repos.updates.insertMany([
      update('a'),
      update('b', { filtered: true, filterReason: 'keyword-deny:广告' }),
    ])

    assert.deepEqual(c.repos.updates.list({ limit: 10 }).map((u) => u.dynId), ['a'])
    assert.equal(c.repos.updates.list({ limit: 10, includeFiltered: true }).length, 2)
    assert.equal(c.repos.updates.get('b')?.filterReason, 'keyword-deny:广告')
    c.close()
  })

  it('countSince 只数窗口内的', () => {
    const c = freshCore()
    c.repos.updates.insertMany([
      update('old', { pubTs: 100 }),
      update('new1', { pubTs: 5_000 }),
      update('new2', { pubTs: 6_000 }),
    ])
    assert.equal(c.repos.updates.countSince(1_000), 2)
    c.close()
  })
})

describe('summary jobs', () => {
  it('同一个 bvid 只有一条任务，重新入队会重置为 pending', () => {
    const c = freshCore()
    c.repos.updates.insertMany([update('a')])

    const job = c.repos.jobs.enqueue({ bvid: 'BVa', updateId: 'a', at: 1_000 })
    assert.equal(job.status, 'pending')

    const claimed = c.repos.jobs.claimNext(1_100)
    assert.equal(claimed?.id, job.id)
    assert.equal(claimed?.status, 'running')
    assert.equal(c.repos.jobs.claimNext(1_200), null, '没有 pending 了')

    c.repos.jobs.finish(job.id, { ok: false, error: 'ASR 挂了' }, 1_300)
    assert.equal(c.repos.jobs.get(job.id)?.status, 'failed')

    // 重试：同一个 bvid 不该长出第二条任务。
    const again = c.repos.jobs.enqueue({ bvid: 'BVa', updateId: 'a', at: 2_000 })
    assert.equal(again.id, job.id)
    assert.equal(again.status, 'pending')
    assert.equal(c.repos.jobs.list({ limit: 10 }).length, 1)
    c.close()
  })

  it('启动时把崩在 running 的任务捡回来续跑', () => {
    const c = freshCore()
    c.repos.updates.insertMany([update('a'), update('b')])
    c.repos.jobs.enqueue({ bvid: 'BVa', updateId: 'a', at: 1_000 })
    c.repos.jobs.enqueue({ bvid: 'BVb', updateId: 'b', at: 1_000 })
    c.repos.jobs.claimNext(1_100)

    assert.equal(c.repos.jobs.resetRunning(2_000), 1)
    assert.equal(c.repos.jobs.list({ status: 'pending', limit: 10 }).length, 2)
    assert.equal(c.repos.jobs.resetRunning(2_100), 0, '没有 running 时是空操作')
    c.close()
  })

  it('setStage 记录当前阶段，供工作台看进度', () => {
    const c = freshCore()
    c.repos.updates.insertMany([update('a')])
    const job = c.repos.jobs.enqueue({ bvid: 'BVa', updateId: 'a', at: 1_000 })

    c.repos.jobs.setStage(job.id, 'asr', 1_200)
    assert.equal(c.repos.jobs.getByBvid('BVa')?.stage, 'asr')
    c.close()
  })
})

describe('summaries', () => {
  it('按 bvid upsert，长 transcript 分开存', () => {
    const c = freshCore()
    const summary = {
      bvid: 'BVa',
      tldr: '一句话',
      article: '## Overview\n\n开场讲了背景。',
      fullMd: '# 全文',
      transcriptSource: 'asr' as const,
      degradePath: 'asr' as const,
      confidence: 'low' as const,
      createdAt: 3_000,
    }
    c.repos.summaries.upsert(summary, '很长的逐字稿'.repeat(100))

    const got = c.repos.summaries.get('BVa')
    assert.deepEqual(got, summary)

    c.repos.summaries.upsert({ ...summary, tldr: '改了', confidence: 'high' })
    assert.equal(c.repos.summaries.get('BVa')?.tldr, '改了')
    assert.equal(c.repos.summaries.list({ limit: 10 }).length, 1)
    c.close()
  })
})

describe('deliveries', () => {
  it('(update, channel, kind) 唯一：抢不到就不发第二遍', () => {
    const c = freshCore()
    c.repos.updates.insertMany([update('a')])

    const d = { updateId: 'a', channel: 'ntfy' as const, kind: 'discover' as const, at: 1_000 }
    assert.equal(c.repos.deliveries.claim(d), true)
    assert.equal(c.repos.deliveries.claim({ ...d, at: 1_100 }), false, '同一条不能抢两次')

    // 换渠道、换类型都是另一条投递。
    assert.equal(c.repos.deliveries.claim({ ...d, channel: 'wxpusher' }), true)
    assert.equal(c.repos.deliveries.claim({ ...d, kind: 'summary' }), true)

    c.repos.deliveries.settle(d, { status: 'sent', error: null }, 1_200)
    const rec = c.repos.deliveries.listForUpdate('a').find((r) => r.channel === 'ntfy' && r.kind === 'discover')
    assert.equal(rec?.status, 'sent')
    assert.equal(rec?.attempts, 1)
    c.close()
  })

  it('失败过的投递可以重抢，成功的不行', () => {
    const c = freshCore()
    c.repos.updates.insertMany([update('a')])
    const d = { updateId: 'a', channel: 'ntfy' as const, kind: 'discover' as const, at: 1_000 }

    c.repos.deliveries.claim(d)
    c.repos.deliveries.settle(d, { status: 'failed', error: '502' }, 1_100)
    assert.equal(c.repos.deliveries.claim({ ...d, at: 1_200 }), true, 'failed 应当可重试')

    c.repos.deliveries.settle(d, { status: 'sent', error: null }, 1_300)
    assert.equal(c.repos.deliveries.claim({ ...d, at: 1_400 }), false, 'sent 之后不能再发')
    c.close()
  })
})

describe('llm calls', () => {
  it('逐次记账，窗口内汇总', () => {
    const c = freshCore()
    c.repos.llmCalls.record({ bvid: 'BVa', stage: 'map', model: 'm', inTokens: 100, outTokens: 20, ms: 900, at: 1_000 })
    c.repos.llmCalls.record({ bvid: 'BVa', stage: 'reduce', model: 'm', inTokens: 50, outTokens: 10, ms: 400, at: 2_000 })
    c.repos.llmCalls.record({ bvid: null, stage: 'ping', model: 'm', inTokens: 1, outTokens: 1, ms: 10, at: 100 })

    assert.deepEqual(c.repos.llmCalls.usageSince(500), { calls: 2, inTokens: 150, outTokens: 30 })
    assert.deepEqual(c.repos.llmCalls.usageSince(0), { calls: 3, inTokens: 151, outTokens: 31 })
    c.close()
  })
})
