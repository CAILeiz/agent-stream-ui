/**
 * 领域类型：事件协议 + 会话状态。
 *
 * 设计约束：事件是**线上协议**，状态是**渲染输入**。两者刻意分开——
 * 服务端换实现只要仍发这套事件，前端不用改；前端换渲染只要仍读这套状态，
 * 传输层也不用改。
 */

/* ------------------------------------------------------------------ *
 * 1. 事件协议（服务端 → 客户端，SSE `data:` 里的 JSON）
 * ------------------------------------------------------------------ */

export type ErrorStage = 'retrieve' | 'analyze' | 'generate' | 'unknown'

export interface AgentEventPayloads {
  'turn.start': { turnId: string }
  'message.delta': { text: string }
  'message.done': { messageId?: string }
  'tool.call': { callId: string; name: string; arguments?: string }
  'tool.result': {
    callId: string
    ok: boolean
    preview?: string
    durationMs?: number
  }
  'turn.end': { reason: 'complete' | 'stopped' | 'error' }
  error: { message: string; stage?: ErrorStage; retriable?: boolean }
  ping: { at?: number }
}

export type AgentEventType = keyof AgentEventPayloads

/** 判别联合：`switch (event.type)` 之后 payload 自动收窄。 */
export type AgentEvent = {
  [K in AgentEventType]: { type: K } & AgentEventPayloads[K]
}[AgentEventType]

export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  'turn.start',
  'message.delta',
  'message.done',
  'tool.call',
  'tool.result',
  'turn.end',
  'error',
  'ping',
]

/* ------------------------------------------------------------------ *
 * 2. 渲染状态
 * ------------------------------------------------------------------ */

export type ToolStatus = 'running' | 'ok' | 'error'

export interface ToolCallState {
  callId: string
  name: string
  /** 原始入参文本。流式到达时可能是不完整的 JSON，UI 必须容忍。 */
  args: string
  /** 入参是否已完整（收到 tool.result，或被后续事件判定结束）。 */
  argsComplete: boolean
  status: ToolStatus
  preview?: string
  durationMs?: number
  startedAt: number
}

/**
 * 消息内容按到达顺序切片：文本和工具卡交错，而不是"先正文后工具"。
 * 这一点在真实 Agent 里很关键——模型可能"说一句 → 调工具 → 接着说"。
 */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; callId: string }

export type TurnStatus = 'running' | 'done' | 'error' | 'stopped'

export interface AgentError {
  message: string
  stage: ErrorStage
  retriable: boolean
}

export interface LiveTurn {
  turnId: string | null
  status: TurnStatus
  parts: MessagePart[]
  toolCalls: ToolCallState[]
  error: AgentError | null
  /** 传输层掉线、正在重连时为 true（区别于模型报错）。 */
  interrupted: boolean
  startedAt: number
  endedAt: number | null
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  parts: MessagePart[]
  toolCalls: ToolCallState[]
  status: Exclude<TurnStatus, 'running'>
  createdAt: number
  /** 失败回合的落库错误，供已提交消息继续展示重试入口。 */
  error?: AgentError
}

export type SseStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'stopped'
  | 'error'

export interface SseStatusInfo {
  attempt: number
  delayMs: number
  reason?: string
}

export interface ConversationSnapshot {
  messages: Message[]
  live: LiveTurn | null
  status: SseStatus
  reconnect: SseStatusInfo | null
}
