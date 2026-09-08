import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compileRegex } from '../src/server/domain/filter.ts'
import { TimedRegex } from '../src/server/infra/regex/timed-regex.ts'
import { CollectingLogger } from './fakes/logger.ts'

/**
 * 用户手写的正则要能被打断，否则一个 `(a+)+` 就把轮询卡死。
 * 这里测的是「真的中断了」，所以用一条已知会灾难性回溯的表达式。
 */
describe('TimedRegex', () => {
  it('正常正则照常匹配', () => {
    const re = new TimedRegex(() => 100, new CollectingLogger())
    assert.equal(re.test('恰饭|带货', '今天带货'), true)
    assert.equal(re.test('恰饭|带货', '技术分享'), false)
  })

  it('灾难性回溯会被超时打断，并且之后还能继续用', () => {
    const re = new TimedRegex(() => 100, new CollectingLogger())
    const started = Date.now()
    assert.equal(re.test('^(a+)+$', `${'a'.repeat(40)}b`), 'timeout')
    // 100ms 预算，给足余量到 1s：关键是它有上限，不是精确耗时。
    assert.ok(Date.now() - started < 1_000)
    // 一条规则跑废不该毁掉整个匹配器。
    assert.equal(re.test('带货', '今天带货'), true)
  })

  it('编译不过的正则算失败，不抛', () => {
    assert.equal(compileRegex('('), null)
    assert.equal(new TimedRegex(() => 100, new CollectingLogger()).test('(', '随便'), 'timeout')
  })
})
