import { describe, expect, it } from 'vitest'
import {
  decodeAgentEvent,
  initialSnapshot,
  reduceAgentEvent,
  repairPartialJson,
  settleOrphanLiveTurn,
  stopLiveTurn,
} from '../src/lib/core/reducer'
import type { AgentEvent } from '../src/lib/types'

const at = 1_700_000_000_000

function step(events: AgentEvent[], start = initialSnapshot()) {
  return events.reduce((snapshot, event) => reduceAgentEvent(snapshot, event, at), start)
}

describe('reduceAgentEvent', () => {
  it('相邻 delta 合并成一个文本片段', () => {
    const snapshot = step([
      { type: 'turn.start', turnId: 't1' },
      { type: 'message.delta', text: '你' },
      { type: 'message.delta', text: '好' },
    ])

    expect(snapshot.live?.parts).toEqual([{ kind: 'text', text: '你好' }])
    expect(snapshot.live?.turnId).toBe('t1')
  })

  it('工具调用插在文本之间，之后的 delta 新起一段', () => {
    const snapshot = step([
      { type: 'turn.start', turnId: 't1' },
      { type: 'message.delta', text: '查一下' },
      { type: 'tool.call', callId: 'c1', name: 'search', arguments: '{"q":' },
      { type: 'message.delta', text: '结果如下' },
    ])

    expect(snapshot.live?.parts).toEqual([
      { kind: 'text', text: '查一下' },
      { kind: 'tool', callId: 'c1' },
      { kind: 'text', text: '结果如下' },
    ])
    expect(snapshot.live?.toolCalls[0]?.args).toBe('{"q":')
    expect(snapshot.live?.toolCalls[0]?.argsComplete).toBe(false)
  })

  it('重复的 tool.call 不重复插入片段（重连重放）', () => {
    const snapshot = step([
      { type: 'turn.start', turnId: 't1' },
      { type: 'tool.call', callId: 'c1', name: 'search' },
      { type: 'tool.call', callId: 'c1', name: 'search' },
    ])

    expect(snapshot.live?.parts).toHaveLength(1)
    expect(snapshot.live?.toolCalls).toHaveLength(1)
  })

  it('tool.args 增量拼接入参（OpenAI 的流式工具参数）', () => {
    const snapshot = step([
      { type: 'turn.start', turnId: 't1' },
      { type: 'tool.call', callId: 'c1', name: 'search', arguments: '' },
      { type: 'tool.args', callId: 'c1', arguments: '{"q":' },
      { type: 'tool.args', callId: 'c1', arguments: '"杭州"}' },
    ])

    expect(snapshot.live?.toolCalls[0]?.args).toBe('{"q":"杭州"}')
    expect(snapshot.live?.toolCalls[0]?.argsComplete).toBe(false)

    const completed = reduceAgentEvent(
      snapshot,
      { type: 'tool.args', callId: 'c1', arguments: '', complete: true },
      at,
    )
    expect(completed.live?.toolCalls[0]?.argsComplete).toBe(true)
  })

  it('未知 callId 的 tool.args 被忽略（不会凭空造卡）', () => {
    const snapshot = step([
      { type: 'turn.start', turnId: 't1' },
      { type: 'tool.args', callId: 'ghost', arguments: '{}' },
    ])
    expect(snapshot.live?.toolCalls).toHaveLength(0)
  })

  it('tool.result 落状态与耗时', () => {
    const snapshot = step([
      { type: 'turn.start', turnId: 't1' },
      { type: 'tool.call', callId: 'c1', name: 'search' },
      { type: 'tool.result', callId: 'c1', ok: true, preview: '3 hits', durationMs: 88 },
    ])

    const tool = snapshot.live?.toolCalls[0]
    expect(tool?.status).toBe('ok')
    expect(tool?.argsComplete).toBe(true)
    expect(tool?.preview).toBe('3 hits')
    expect(tool?.durationMs).toBe(88)
  })

  it('turn.end 提交消息并清空 live', () => {
    const snapshot = step([
      { type: 'turn.start', turnId: 't1' },
      { type: 'message.delta', text: '答案' },
      { type: 'turn.end', reason: 'complete' },
    ])

    expect(snapshot.live).toBeNull()
    expect(snapshot.messages).toHaveLength(1)
    expect(snapshot.messages[0]?.status).toBe('done')
    expect(snapshot.messages[0]?.parts).toEqual([{ kind: 'text', text: '答案' }])
  })

  it('没有内容时 turn.end 不产生空消息', () => {
    const snapshot = step([
      { type: 'turn.start', turnId: 't1' },
      { type: 'turn.end', reason: 'complete' },
    ])

    expect(snapshot.messages).toHaveLength(0)
  })

  it('error 有内容时提交为失败消息，无内容时保留 live 供重试', () => {
    const withContent = step([
      { type: 'turn.start', turnId: 't1' },
      { type: 'message.delta', text: '半截' },
      { type: 'error', message: 'boom', stage: 'generate', retriable: true },
    ])
    expect(withContent.messages[0]?.status).toBe('error')
    expect(withContent.live).toBeNull()

    const withoutContent = step([{ type: 'error', message: 'boom', retriable: true }])
    expect(withoutContent.messages).toHaveLength(0)
    expect(withoutContent.live?.error?.message).toBe('boom')
  })

  it('ping 不改变快照引用（避免无意义渲染）', () => {
    const snapshot = step([{ type: 'turn.start', turnId: 't1' }])
    expect(reduceAgentEvent(snapshot, { type: 'ping' })).toBe(snapshot)
  })

  it('停止时把还在跑的工具标成未返回', () => {
    const running = step([
      { type: 'turn.start', turnId: 't1' },
      { type: 'message.delta', text: '处理中' },
      { type: 'tool.call', callId: 'c1', name: 'slow' },
    ])

    const stopped = stopLiveTurn(running, at)
    expect(stopped.live).toBeNull()
    expect(stopped.messages[0]?.status).toBe('stopped')
    expect(stopped.messages[0]?.toolCalls[0]?.status).toBe('error')
  })

  it('流意外结束时收敛成可重试错误', () => {
    const snapshot = step([
      { type: 'turn.start', turnId: 't1' },
      { type: 'message.delta', text: '半截' },
    ])

    const settled = settleOrphanLiveTurn(snapshot, at)
    expect(settled.messages[0]?.status).toBe('error')
  })
})

describe('decodeAgentEvent', () => {
  it('未知事件返回 null', () => {
    expect(decodeAgentEvent('unknown.event', '{}')).toBeNull()
  })

  it('坏 JSON 返回 null 而不是抛错', () => {
    expect(decodeAgentEvent('message.delta', '{not json')).toBeNull()
  })

  it('合法事件带上 type', () => {
    expect(decodeAgentEvent('message.delta', '{"text":"hi"}')).toEqual({
      type: 'message.delta',
      text: 'hi',
    })
  })
})

describe('repairPartialJson', () => {
  it('完整 JSON 直接返回', () => {
    expect(repairPartialJson('{"a":1}')).toEqual({ value: { a: 1 }, complete: true })
  })

  it('补齐未闭合的对象', () => {
    expect(repairPartialJson('{"a":1,"b":[2,3')).toEqual({
      value: { a: 1, b: [2, 3] },
      complete: false,
    })
  })

  it('去掉悬空逗号后补齐', () => {
    expect(repairPartialJson('{"a":1,')).toEqual({ value: { a: 1 }, complete: false })
  })

  it('悬空冒号补 null', () => {
    expect(repairPartialJson('{"a":')).toEqual({ value: { a: null }, complete: false })
  })

  it('截断在字符串中间时放弃（宁可不显示，也不猜）', () => {
    expect(repairPartialJson('{"a":"半截')).toBeNull()
  })

  it('空串或纯空白返回 null', () => {
    expect(repairPartialJson('   ')).toBeNull()
  })

  it('非对象字面量也能解析', () => {
    expect(repairPartialJson('"str"')).toEqual({ value: 'str', complete: true })
  })
})
