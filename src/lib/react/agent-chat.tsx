import type { ReactNode } from 'react'
import type { AgentStreamStore } from '../core/store'
import type { SseStatus } from '../types'
import { useAgentStream } from './use-agent-stream'
import { MessageList } from './message-list'
import { Composer } from './composer'
import { SparkIcon } from './icons'

export interface AgentChatProps {
  store: AgentStreamStore
  title?: string
  subtitle?: string
  placeholder?: string
  suggestions?: readonly string[]
  footer?: ReactNode
  emptyState?: ReactNode
  className?: string
}

const STATUS_TEXT: Record<SseStatus, string> = {
  idle: '就绪',
  connecting: '连接中',
  open: '生成中',
  reconnecting: '重连中',
  closed: '就绪',
  stopped: '已停止',
  error: '连接异常',
}

export function AgentChat({
  store,
  title = 'Agent 对话',
  subtitle,
  placeholder,
  suggestions = [],
  footer,
  emptyState,
  className,
}: AgentChatProps) {
  const snapshot = useAgentStream(store)
  const running = snapshot.live?.status === 'running'
  const canRetry =
    snapshot.live?.status === 'error' ||
    snapshot.status === 'error' ||
    snapshot.messages.at(-1)?.status === 'error'

  const tone =
    snapshot.status === 'error'
      ? 'error'
      : snapshot.status === 'reconnecting'
        ? 'warn'
        : running
          ? 'busy'
          : 'ok'

  const reconnectLabel =
    snapshot.status === 'reconnecting' && snapshot.reconnect
      ? ` · 第 ${snapshot.reconnect.attempt} 次`
      : ''

  return (
    <div className={className ? `asui-chat ${className}` : 'asui-chat'}>
      <header className="asui-header">
        <div className="asui-brand">
          <span className="asui-brand-mark">
            <SparkIcon width={14} height={14} />
          </span>
          <div>
            <h1 className="asui-title">{title}</h1>
            {subtitle && <p className="asui-subtitle">{subtitle}</p>}
          </div>
        </div>

        <span className={`asui-badge asui-badge--${tone}`} data-testid="status-badge">
          <i />
          {STATUS_TEXT[snapshot.status]}
          {reconnectLabel}
        </span>
      </header>

      <MessageList
        snapshot={snapshot}
        onRetry={store.retry}
        emptyState={
          emptyState ?? (
            <div className="asui-empty-inner">
              <SparkIcon width={22} height={22} />
              <h2>问点需要查证的问题</h2>
              <p>工具调用会以卡片形式展开，失败可以重试，断线会自动续传。</p>
              {suggestions.length > 0 && (
                <div className="asui-suggestions">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="asui-suggestion"
                      onClick={() => store.send(suggestion)}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        }
      />

      <Composer
        running={running === true}
        canRetry={canRetry === true}
        placeholder={placeholder ?? '发消息…'}
        onSend={store.send}
        onStop={store.stop}
        onRetry={store.retry}
      />

      {footer && <div className="asui-footer">{footer}</div>}
    </div>
  )
}
