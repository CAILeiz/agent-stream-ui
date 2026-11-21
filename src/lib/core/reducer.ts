/**
 * 事件 → 状态的折叠（reducer）。
 *
 * 这是整个库的核心：一个纯函数把"半可靠、可能重放、可能乱序"的事件流，
 * 折叠成 UI 可以直接渲染的状态。所有边界规则都在这里，组件只管画。
 */

import type {
  AgentError,
  AgentEvent,
  AgentEventType,
  ConversationSnapshot,
  LiveTurn,
  Message,
  MessagePart,
  SseStatus,
  SseStatusInfo,
  ToolCallState,
  TurnStatus,
} from '../types'

const KNOWN_TYPES = new Set<string>([
  'turn.start',
  'message.delta',
  'message.done',
  'tool.call',
  'tool.result',
  'turn.end',
  'error',
  'ping',
])

export function isAgentEventType(type: string): type is AgentEventType {
  return KNOWN_TYPES.has(type)
}

/** 把服务端帧解析成事件；未知事件 / 坏 JSON 返回 null 而不是抛错。 */
export function decodeAgentEvent(event: string, data: string): AgentEvent | null {
  if (!isAgentEventType(event)) return null

  let payload: unknown
  try {
    payload = data === '' ? {} : JSON.parse(data)
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object') return null

  return { type: event, ...(payload as object) } as AgentEvent
}

/* ------------------------------------------------------------------ *
 * 工具调用入参：流式到达的可能是残缺 JSON
 * ------------------------------------------------------------------ */

/**
 * 把模型边生成边吐出的参数补成可解析的 JSON。
 * 只做"未闭合字符串/括号/悬空分隔符"的收尾，不做语义修复——
 * 过度的猜测会让用户看到假参数，比"解析中"更糟。
 */
export function repairPartialJson(raw: string): { value: unknown; complete: boolean } | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  try {
    return { value: JSON.parse(trimmed), complete: true }
  } catch {
    // 继续走修复
  }

  const repaired = closeOpenJson(trimmed)
  if (repaired === null) return null

  try {
    return { value: JSON.parse(repaired), complete: false }
  } catch {
    return null
  }
}

function closeOpenJson(input: string): string | null {
  const stack: string[] = []
  let inString = false
  let escaped = false
  let cutAt = -1

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]

    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') inString = true
    else if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      if (stack.length === 0) return null
      stack.pop()
      if (stack.length === 0) cutAt = index
    }
  }

  if (inString) {
    // 截断在字符串中间：去掉未完成的键或值，修复成本太高，交给 UI 显示原文
    return null
  }

  if (cutAt !== -1) {
    // 外层对象已闭合，后面跟了多余内容（比如多个 JSON 拼接）—— 取第一段
    return input.slice(0, cutAt + 1)
  }

  if (stack.length === 0) return null

  // 悬空的分隔符：`{"a": 1,` → 去掉尾逗号再补括号
  let body = input.replace(/,\s*$/, '')
  if (body.endsWith(':')) body = `${body} null`
  const closers = stack
    .slice()
    .reverse()
    .map((open) => (open === '{' ? '}' : ']'))
    .join('')
  return body + closers
}

/* ------------------------------------------------------------------ *
 * 初始值
 * ------------------------------------------------------------------ */

export const initialLiveTurn = (now = Date.now()): LiveTurn => ({
  turnId: null,
  status: 'running',
  parts: [],
  toolCalls: [],
  error: null,
  interrupted: false,
  startedAt: now,
  endedAt: null,
})

export const initialSnapshot = (): ConversationSnapshot => ({
  messages: [],
  live: null,
  status: 'idle',
  reconnect: null,
})

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

function appendText(parts: MessagePart[], text: string): MessagePart[] {
  if (text === '') return parts
  const last = parts[parts.length - 1]
  if (last && last.kind === 'text') {
    // 合并相邻文本，避免每次 delta 新增一个数组元素
    const next = parts.slice(0, -1)
    next.push({ kind: 'text', text: last.text + text })
    return next
  }
  return [...parts, { kind: 'text', text }]
}

function upsertTool(toolCalls: ToolCallState[], call: ToolCallState): ToolCallState[] {
  const index = toolCalls.findIndex((item) => item.callId === call.callId)
  if (index === -1) return [...toolCalls, call]
  const next = toolCalls.slice()
  next[index] = call
  return next
}

let fallbackId = 0
function nextId(prefix: string): string {
  fallbackId += 1
  return `${prefix}-${Date.now().toString(36)}-${fallbackId}`
}

function finalizeLive(
  live: LiveTurn,
  status: Exclude<TurnStatus, 'running'>,
  now: number,
  error?: AgentError,
): Message | null {
  const hasContent = live.parts.some(
    (part) => part.kind === 'tool' || (part.kind === 'text' && part.text.trim() !== ''),
  )
  if (!hasContent) return null

  return {
    id: live.turnId ?? nextId('assistant'),
    role: 'assistant',
    parts: live.parts,
    toolCalls: live.toolCalls.map((tool) =>
      tool.status === 'running'
        ? { ...tool, status: 'error' as const, preview: tool.preview ?? '未返回结果' }
        : tool,
    ),
    status,
    createdAt: live.startedAt || now,
    ...(error === undefined ? {} : { error }),
  }
}

/* ------------------------------------------------------------------ *
 * 对外 reducer
 * ------------------------------------------------------------------ */

export function reduceAgentEvent(
  snapshot: ConversationSnapshot,
  event: AgentEvent,
  now = Date.now(),
): ConversationSnapshot {
  switch (event.type) {
    case 'ping':
      return snapshot

    case 'turn.start':
      return {
        ...snapshot,
        live: { ...initialLiveTurn(now), turnId: event.turnId, startedAt: now },
      }

    case 'message.delta': {
      const live = snapshot.live ?? initialLiveTurn(now)
      return {
        ...snapshot,
        live: { ...live, parts: appendText(live.parts, event.text) },
      }
    }

    case 'tool.call': {
      const live = snapshot.live ?? initialLiveTurn(now)
      const tool: ToolCallState = {
        callId: event.callId,
        name: event.name,
        args: event.arguments ?? '',
        argsComplete: false,
        status: 'running',
        startedAt: now,
      }
      return {
        ...snapshot,
        live: {
          ...live,
          toolCalls: upsertTool(live.toolCalls, tool),
          // 同一个 callId 可能因重连被重放，parts 必须幂等
          parts: partExistsFor(live.parts, event.callId)
            ? live.parts
            : [...live.parts, { kind: 'tool', callId: event.callId }],
        },
      }
    }

    case 'tool.result': {
      const live = snapshot.live
      if (!live) return snapshot
      const existing = live.toolCalls.find((item) => item.callId === event.callId)
      if (!existing) return snapshot

      const updated: ToolCallState = {
        ...existing,
        argsComplete: true,
        status: event.ok ? 'ok' : 'error',
        preview: event.preview ?? existing.preview,
        durationMs: event.durationMs ?? now - existing.startedAt,
      }
      return {
        ...snapshot,
        live: { ...live, toolCalls: upsertTool(live.toolCalls, updated) },
      }
    }

    case 'message.done': {
      const live = snapshot.live
      if (!live) return snapshot
      return { ...snapshot, live: { ...live, parts: live.parts } }
    }

    case 'error': {
      const live = snapshot.live ?? initialLiveTurn(now)
      const error: AgentError = {
        message: event.message,
        stage: event.stage ?? 'unknown',
        retriable: event.retriable ?? true,
      }
      const finalized = finalizeLive(live, 'error', now, error)
      return {
        ...snapshot,
        messages: finalized ? [...snapshot.messages, finalized] : snapshot.messages,
        live: finalized ? null : { ...live, status: 'error', error, endedAt: now },
      }
    }

    case 'turn.end': {
      const live = snapshot.live
      if (!live) return snapshot
      const status: Exclude<TurnStatus, 'running'> =
        event.reason === 'stopped' ? 'stopped' : 'done'
      const finalized = finalizeLive(live, status, now)
      return {
        ...snapshot,
        messages: finalized ? [...snapshot.messages, finalized] : snapshot.messages,
        live: null,
      }
    }

    default:
      return snapshot
  }
}

function partExistsFor(parts: MessagePart[], callId: string): boolean {
  return parts.some((part) => part.kind === 'tool' && part.callId === callId)
}

/* ------------------------------------------------------------------ *
 * 本地动作
 * ------------------------------------------------------------------ */

export function appendUserMessage(
  snapshot: ConversationSnapshot,
  text: string,
  now = Date.now(),
): ConversationSnapshot {
  const trimmed = text.trim()
  if (trimmed === '') return snapshot
  return {
    ...snapshot,
    messages: [
      ...snapshot.messages,
      {
        id: nextId('user'),
        role: 'user',
        parts: [{ kind: 'text', text: trimmed }],
        toolCalls: [],
        status: 'done',
        createdAt: now,
      },
    ],
  }
}

/** 用户点"停止"：本地立即收尾，不等服务端确认。 */
export function stopLiveTurn(
  snapshot: ConversationSnapshot,
  now = Date.now(),
): ConversationSnapshot {
  const live = snapshot.live
  if (!live) return snapshot
  const finalized = finalizeLive(live, 'stopped', now)
  return {
    ...snapshot,
    messages: finalized ? [...snapshot.messages, finalized] : snapshot.messages,
    live: null,
    status: 'stopped',
  }
}

/** 传输层状态变化：只影响"是否在重连"，不改消息内容。 */
export function applySseStatus(
  snapshot: ConversationSnapshot,
  status: SseStatus,
  info?: SseStatusInfo,
): ConversationSnapshot {
  const interrupted = status === 'reconnecting'
  const reconnect = interrupted ? (info ?? null) : null
  const live = snapshot.live
  return {
    ...snapshot,
    status,
    reconnect,
    live: live && live.interrupted !== interrupted ? { ...live, interrupted } : live,
  }
}

/**
 * 流意外结束（服务端关闭但没发 turn.end）：把还在跑的回合收成错误态，
 * 而不是让它永远转圈。这是"UI 不能撒谎"的最小要求。
 */
export function settleOrphanLiveTurn(
  snapshot: ConversationSnapshot,
  now = Date.now(),
): ConversationSnapshot {
  const live = snapshot.live
  if (!live) return snapshot
  return reduceAgentEvent(
    snapshot,
    {
      type: 'error',
      message: '连接已断开，本轮未完成',
      stage: 'unknown',
      retriable: true,
    },
    now,
  )
}
