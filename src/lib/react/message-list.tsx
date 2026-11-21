import { useMemo } from 'react'
import type { ConversationSnapshot } from '../types'
import { ErrorNote, MessageBody } from './message-body'
import { useStickToBottom } from './use-stick-to-bottom'
import { ArrowDownIcon, RetryIcon } from './icons'

export interface MessageListProps {
  snapshot: ConversationSnapshot
  onRetry?: () => void
  emptyState?: React.ReactNode
}

export function MessageList({ snapshot, onRetry, emptyState }: MessageListProps) {
  const { messages, live } = snapshot

  // 内容签名：只有真正影响布局的东西变化时才触发贴底滚动
  const signature = useMemo(() => {
    const liveLength =
      live?.parts.reduce((total, part) => (part.kind === 'text' ? total + part.text.length : total), 0) ??
      0
    return `${messages.length}:${liveLength}:${live?.status ?? 'none'}`
  }, [messages.length, live])

  const { ref, pinned, scrollToBottom } = useStickToBottom<HTMLDivElement>(signature)

  if (messages.length === 0 && !live) {
    return <div className="asui-empty">{emptyState}</div>
  }

  return (
    <div className="asui-list" ref={ref} role="log" aria-live="polite">
      <div className="asui-list-inner">
        {messages.map((message) => (
          <article
            key={message.id}
            className={`asui-msg asui-msg--${message.role}`}
            data-testid={`message-${message.role}`}
          >
            {message.role === 'assistant' && (
              <>
                <MessageBody
                  parts={message.parts}
                  toolCalls={message.toolCalls}
                  streaming={false}
                  role="assistant"
                />
                {message.error && (
                  <div className="asui-error-wrap">
                    <ErrorNote message={message.error.message} stage={message.error.stage} />
                    {onRetry && (
                      <button type="button" className="asui-inline-retry" onClick={onRetry}>
                        <RetryIcon /> 重试本轮
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            {message.role === 'user' && (
              <p className="asui-user-text">
                {message.parts
                  .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
                  .map((part) => part.text)
                  .join('\n')}
              </p>
            )}
          </article>
        ))}

        {live && (
          <article className="asui-msg asui-msg--assistant" data-testid="message-live">
            <MessageBody
              parts={live.parts}
              toolCalls={live.toolCalls}
              streaming={live.status === 'running' && !live.interrupted}
              role="assistant"
            />
            {live.interrupted && live.status === 'running' && (
              <p className="asui-interrupted" data-testid="interrupted-hint">
                连接中断，正在续传…
              </p>
            )}
            {live.error && (
              <div className="asui-error-wrap">
                <ErrorNote message={live.error.message} stage={live.error.stage} />
                {onRetry && (
                  <button type="button" className="asui-inline-retry" onClick={onRetry}>
                    <RetryIcon /> 重试本轮
                  </button>
                )}
              </div>
            )}
          </article>
        )}
      </div>

      {!pinned && (
        <button
          type="button"
          className="asui-jump-bottom"
          onClick={scrollToBottom}
          aria-label="回到底部"
        >
          <ArrowDownIcon />
        </button>
      )}
    </div>
  )
}
