import './styles.css'

/**
 * 库入口。组件和纯逻辑都在这里导出——纯函数部分可以单独在服务端/Node 里测。
 */

// 类型
export type {
  AgentError,
  AgentEvent,
  AgentEventPayloads,
  AgentEventType,
  ConversationSnapshot,
  ErrorStage,
  LiveTurn,
  Message,
  MessagePart,
  SseStatus,
  SseStatusInfo,
  ToolCallState,
  ToolStatus,
  TurnStatus,
} from './types'
export { AGENT_EVENT_TYPES } from './types'

// SSE
export { formatSseFrame, isNewerEventId, parseSseChunk, parseSseFrame } from './sse/frame'
export type { SseFrame } from './sse/frame'
export {
  computeBackoff,
  createSseClient,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_FACTOR,
  DEFAULT_BACKOFF_MAX_MS,
  shouldRetryStatus,
} from './sse/client'
export type {
  RetryContext,
  SseClient,
  SseClientOptions,
} from './sse/client'

// 核心
export {
  appendUserMessage,
  applySseStatus,
  decodeAgentEvent,
  initialLiveTurn,
  initialSnapshot,
  isAgentEventType,
  reduceAgentEvent,
  repairPartialJson,
  settleOrphanLiveTurn,
  stopLiveTurn,
} from './core/reducer'
export { createAgentStream } from './core/store'
export type { AgentStreamOptions, AgentStreamStore } from './core/store'
export {
  createHttpTransport,
  createScriptedTransport,
  toWireHistory,
} from './core/transport'
export type {
  HttpTransportOptions,
  ScriptedChunk,
  ScriptedTransportOptions,
  Transport,
  TransportOpenContext,
} from './core/transport'
export { defaultScheduler, immediateScheduler, rafScheduler } from './core/scheduler'
export type { FlushScheduler } from './core/scheduler'

// 适配器
export { createOpenAIStreamTranslator } from './adapters/openai'
export type {
  OpenAIStreamChunk,
  OpenAIStreamTranslator,
  OpenAIToolCallDelta,
  OpenAIToolCallRef,
} from './adapters/openai'

// Markdown
export { listItemText, splitBlocks } from './markdown/blocks'
export type { BlockKind, MdBlock } from './markdown/blocks'
export { isSafeHref, parseInline, parseInlineLines } from './markdown/inline'
export { clearBlockCache, MarkdownBlockView, renderBlock } from './markdown/render'

// React
export { AgentChat } from './react/agent-chat'
export type { AgentChatProps } from './react/agent-chat'
export { Composer } from './react/composer'
export type { ComposerProps } from './react/composer'
export { MarkdownStream } from './react/markdown-stream'
export type { MarkdownStreamProps } from './react/markdown-stream'
export { MessageBody, ErrorNote } from './react/message-body'
export type { MessageBodyProps } from './react/message-body'
export { MessageList } from './react/message-list'
export type { MessageListProps } from './react/message-list'
export { ToolCallCard } from './react/tool-call-card'
export type { ToolCallCardProps } from './react/tool-call-card'
export { useAgentStream } from './react/use-agent-stream'
export { useStickToBottom } from './react/use-stick-to-bottom'
