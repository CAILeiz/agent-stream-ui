import { describe, expect, it } from 'vitest'
import { createOpenAIStreamTranslator } from '../src/lib/adapters/openai'
import type { OpenAIStreamChunk } from '../src/lib/adapters/openai'

type Choice = NonNullable<OpenAIStreamChunk['choices']>[number]

function chunk(payload: Choice): OpenAIStreamChunk {
  return { choices: [payload] }
}

describe('createOpenAIStreamTranslator', () => {
  it('content 增量 → message.delta', () => {
    const translator = createOpenAIStreamTranslator()
    expect(translator.translate(chunk({ delta: { content: '你' } }))).toEqual([
      { type: 'message.delta', text: '你' },
    ])
    expect(translator.translate(chunk({ delta: { content: '' } }))).toEqual([])
  })

  it('首个 tool_calls 分片 → 先建卡片，再给参数增量', () => {
    const translator = createOpenAIStreamTranslator()
    const events = translator.translate(
      chunk({
        delta: {
          tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'search', arguments: '{"q":' } },
          ],
        },
      }),
    )

    expect(events).toEqual([
      { type: 'tool.call', callId: 'call_a', name: 'search', arguments: '' },
      { type: 'tool.args', callId: 'call_a', arguments: '{"q":' },
    ])
  })

  it('后续参数分片只发 tool.args，不重复建卡', () => {
    const translator = createOpenAIStreamTranslator()
    translator.translate(
      chunk({
        delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'search', arguments: '{"q":' } }] },
      }),
    )

    expect(
      translator.translate(chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: '"杭州"}' } }] } })),
    ).toEqual([{ type: 'tool.args', callId: 'call_a', arguments: '"杭州"}' }])
  })

  it('多个并发工具调用按 index 区分', () => {
    const translator = createOpenAIStreamTranslator()
    const events = translator.translate(
      chunk({
        delta: {
          tool_calls: [
            { index: 0, id: 'call_a', function: { name: 'search', arguments: '{"a":1}' } },
            { index: 1, id: 'call_b', function: { name: 'fetch', arguments: '{"b":2}' } },
          ],
        },
      }),
    )

    expect(events.map((event) => event.type)).toEqual([
      'tool.call',
      'tool.args',
      'tool.call',
      'tool.args',
    ])
    expect([...translator.toolCalls.values()]).toEqual([
      { callId: 'call_a', name: 'search' },
      { callId: 'call_b', name: 'fetch' },
    ])
  })

  it('finish_reason=tool_calls 时收口参数', () => {
    const translator = createOpenAIStreamTranslator()
    translator.translate(
      chunk({
        delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'search', arguments: '{"q":"x"}' } }] },
      }),
    )

    const events = translator.translate(chunk({ delta: {}, finish_reason: 'tool_calls' }))
    expect(events).toEqual([{ type: 'tool.args', callId: 'call_a', arguments: '', complete: true }])
    expect(translator.finishReason).toBe('tool_calls')
  })

  it('缺 id 时用 index 兜底，不会丢掉调用', () => {
    const translator = createOpenAIStreamTranslator()
    const events = translator.translate(
      chunk({ delta: { tool_calls: [{ index: 2, function: { name: 'search', arguments: '{}' } }] } }),
    )
    expect(events[0]).toEqual({ type: 'tool.call', callId: 'call_2', name: 'search', arguments: '' })
  })

  it('空 choices / 空 delta 不炸', () => {
    const translator = createOpenAIStreamTranslator()
    expect(translator.translate({})).toEqual([])
    expect(translator.translate({ choices: [] })).toEqual([])
    expect(translator.translate(chunk({ delta: {} }))).toEqual([])
  })

  it('reset 后可以复用（多轮对话）', () => {
    const translator = createOpenAIStreamTranslator()
    translator.translate(chunk({ delta: { content: 'a' } }))
    translator.translate(chunk({ delta: {}, finish_reason: 'stop' }))
    translator.reset()

    expect(translator.finishReason).toBeNull()
    expect(translator.toolCalls.size).toBe(0)
  })
})
