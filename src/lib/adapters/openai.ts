/**
 * OpenAI Chat Completions 流式 chunk → 本库事件协议的适配器。
 *
 * 为什么放进库里而不是示例里：协议差异是所有人接 Agent 时都要写的第一段代码，
 * 而它恰好最容易写错——工具参数是**分片**到达的，`id` 只在第一片出现，
 * `index` 才是稳定的关联键。这些细节写一次、测一次，比每个项目各踩一遍好。
 */

import type { AgentEvent } from '../types'

export interface OpenAIToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

export interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: OpenAIToolCallDelta[]
    }
    finish_reason?: string | null
  }>
}

export interface OpenAIToolCallRef {
  callId: string
  name: string
}

export interface OpenAIStreamTranslator {
  /** 翻译一个上游 chunk；不认识的 chunk 返回空数组而不是抛错。 */
  translate: (chunk: OpenAIStreamChunk) => AgentEvent[]
  /** 上游给的结束原因（`stop` / `tool_calls` / `length` / ...）。 */
  readonly finishReason: string | null
  /** index → 工具调用，供上层执行工具时取用。 */
  readonly toolCalls: ReadonlyMap<number, OpenAIToolCallRef>
  reset: () => void
}

export function createOpenAIStreamTranslator(): OpenAIStreamTranslator {
  let finishReason: string | null = null
  const calls = new Map<number, OpenAIToolCallRef>()
  /** 已经发过 tool.args 的调用，避免空串也发一帧。 */
  const started = new Set<number>()

  const translate = (chunk: OpenAIStreamChunk): AgentEvent[] => {
    const choice = chunk.choices?.[0]
    if (!choice) return []

    const events: AgentEvent[] = []
    const delta = choice.delta ?? {}

    if (typeof delta.content === 'string' && delta.content !== '') {
      events.push({ type: 'message.delta', text: delta.content })
    }

    for (const piece of delta.tool_calls ?? []) {
      const index = piece.index ?? 0

      if (!calls.has(index)) {
        const callId = piece.id ?? `call_${index}`
        const name = piece.function?.name ?? 'unknown_tool'
        calls.set(index, { callId, name })
        // 新调用：先卡片、再参数增量。卡片的 arguments 留空，由 tool.args 填。
        events.push({ type: 'tool.call', callId, name, arguments: '' })
      }

      const call = calls.get(index)!
      const args = piece.function?.arguments
      if (typeof args === 'string' && args !== '') {
        started.add(index)
        events.push({ type: 'tool.args', callId: call.callId, arguments: args })
      }
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason

      if (finishReason === 'tool_calls') {
        // 参数流结束：显式收口，UI 才能把"生成中"换成解析后的参数
        for (const [index, call] of calls) {
          if (!started.has(index)) events.push({ type: 'tool.args', callId: call.callId, arguments: '' })
          events.push({ type: 'tool.args', callId: call.callId, arguments: '', complete: true })
        }
      }
    }

    return events
  }

  return {
    translate,
    get finishReason() {
      return finishReason
    },
    get toolCalls() {
      return calls
    },
    reset() {
      finishReason = null
      calls.clear()
      started.clear()
    },
  }
}
