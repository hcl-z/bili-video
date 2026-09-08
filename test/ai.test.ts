import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AiSettingsResponse, AiTestResponse } from '#shared/contract/api.ts'
import { LLM_API_KEY } from '../src/server/app/ai.ts'
import { classifyProbe } from '../src/server/domain/ai-probe.ts'
import { secretWrite } from '../src/server/domain/secret-write.ts'
import { FakeFetch } from './fakes/bili-fetch.ts'
import { createHarness, type Harness } from './support/harness.ts'

const REAL_KEY = 'sk-real-key-1234'

async function getSettings(h: Harness): Promise<AiSettingsResponse> {
  const res = await h.server.app.request('/api/ai')
  assert.equal(res.status, 200)
  return (await res.json()) as AiSettingsResponse
}

async function patch(h: Harness, patchBody: unknown): Promise<AiSettingsResponse> {
  const res = await h.server.app.request('/api/ai', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patchBody),
  })
  const text = await res.text()
  assert.equal(res.status, 200, text)
  return JSON.parse(text) as AiSettingsResponse
}

describe('AI 配置', () => {
  it('apiKey 三态：空值不修改，null 清空，掩码不当新值', () => {
    assert.deepEqual(secretWrite(undefined, 'sk-1****9abc'), { action: 'keep' })
    assert.deepEqual(secretWrite('  ', 'sk-1****9abc'), { action: 'keep' })
    assert.deepEqual(secretWrite('sk-1****9abc', 'sk-1****9abc'), { action: 'keep' })
    assert.deepEqual(secretWrite(null, 'sk-1****9abc'), { action: 'clear' })
    assert.deepEqual(secretWrite('sk-new', 'sk-1****9abc'), { action: 'set', value: 'sk-new' })
  })

  it('失败分三种：鉴权 / 模型不存在 / 其他', () => {
    const auth = classifyProbe(401, '{"error":{"message":"invalid api key"}}')
    assert.equal(auth.stage, 'auth')
    // 上游原文 + 状态码都带上：429 和 5xx 只有靠状态码才分得清。
    assert.equal(auth.detail, 'HTTP 401：invalid api key')
    assert.equal(classifyProbe(429, 'slow down').detail, 'HTTP 429：slow down')
    assert.equal(classifyProbe(404, '{"error":{"message":"model not found"}}').stage, 'model')
    assert.equal(classifyProbe(500, 'boom').stage, 'unknown')
  })

  it('LLM 调用失败是值不是异常：限流可重试，鉴权错不可重试', async () => {
    const fetch = new FakeFetch().onSequence('/chat/completions', [
      { raw: { choices: [{ message: { content: '总结' } }], usage: { prompt_tokens: 9 } } },
      { status: 429, raw: { error: { message: 'slow down' } } },
      { status: 401, raw: { error: { message: 'bad key' } } },
    ])
    const h = await createHarness({ fetch })
    try {
      await patch(h, { ai: { baseURL: 'https://llm.test/v1', model: 'm1' } })
      const llm = h.server.services.ai.llm()
      assert.notEqual(llm, null)
      const msg = [{ role: 'user' as const, content: 'hi' }]

      const good = await llm!.complete(msg)
      assert.equal(good.ok && good.value.text, '总结')
      assert.equal(good.ok && good.value.usage.inTokens, 9)

      const limited = await llm!.complete(msg)
      assert.equal(limited.ok === false && limited.failure.kind, 'rate-limit')

      const denied = await llm!.complete(msg)
      assert.equal(denied.ok === false && denied.failure.kind, 'fatal')
    } finally {
      await h.close()
    }
  })

  it('掩码往返：把掩码提交回去不会覆盖库里的 key', async () => {
    const h = await createHarness()
    try {
      await patch(h, { llmApiKey: REAL_KEY })
      const s = await getSettings(h)
      assert.equal(s.llmKey.configured, true)
      assert.match(s.llmKey.masked ?? '', /\*/)
      assert.equal(JSON.stringify(s).includes(REAL_KEY), false, '响应里不该出现明文')

      // 页面提交掩码（用户没动那个框）和提交空串是同一件事：都不修改。
      await patch(h, { llmApiKey: s.llmKey.masked, asrApiKey: '' })
      assert.equal(h.core.secrets.get(LLM_API_KEY), REAL_KEY)

      await patch(h, { llmApiKey: null })
      assert.equal(h.core.secrets.get(LLM_API_KEY), null)
      assert.equal((await getSettings(h)).llmKey.configured, false)
    } finally {
      await h.close()
    }
  })

  it('总开关关掉后取不到 LLM，一次请求都不发', async () => {
    const fetch = new FakeFetch().on('/chat/completions', { raw: { choices: [{ message: { content: 'ok' } }] } })
    const h = await createHarness({ fetch })
    try {
      await patch(h, {
        ai: { enabled: true, baseURL: 'https://llm.test/v1', model: 'm1' },
        llmApiKey: REAL_KEY,
      })
      assert.notEqual(h.server.services.ai.llm(), null)

      await patch(h, { ai: { enabled: false } })
      assert.equal(h.server.services.ai.llm(), null)
      assert.equal(fetch.countOf('/chat/completions'), 0)
    } finally {
      await h.close()
    }
  })

  it('连通性测试：LLM 与 ASR 各发一次，分别报结果', async () => {
    const fetch = new FakeFetch()
      .on('/chat/completions', { status: 401, raw: { error: { message: 'invalid api key' } } })
      .on('/models', { raw: { data: [] } })
    const h = await createHarness({
      fetch,
      commands: { probe: async () => ({ found: true, detail: 'mlx-whisper' }) },
    })
    try {
      // 改完就测，没重启 —— 用时读配置这条在这里被顺带测到。
      await patch(h, {
        ai: { baseURL: 'https://llm.test/v1', model: 'm1' },
        asr: { provider: 'mlx-whisper' },
      })
      const first = (await (
        await h.server.app.request('/api/ai/test', { method: 'POST' })
      ).json()) as AiTestResponse
      assert.equal(first.llm.ok, false)
      assert.equal(first.llm.stage, 'auth')
      assert.match(first.llm.detail ?? '', /invalid api key/)
      assert.equal(fetch.countOf('llm.test'), 1)
      assert.equal(first.asr.ok, true, '本机 mlx_whisper 在 PATH 上')

      // 远端 ASR 走 HTTP，探的是 /models。
      await patch(h, { asr: { provider: 'openai-compat', baseURL: 'https://asr.test/v1' } })
      const second = (await (
        await h.server.app.request('/api/ai/test', { method: 'POST' })
      ).json()) as AiTestResponse
      assert.equal(second.asr.ok, true)
      assert.equal(fetch.countOf('asr.test/v1/models'), 1)
    } finally {
      await h.close()
    }
  })
})
