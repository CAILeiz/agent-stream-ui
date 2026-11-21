import type { ConversationSnapshot } from '../lib/types'

export interface LoggedEvent {
  seq: string
  type: string
  at: number
}

export interface InspectorProps {
  snapshot: ConversationSnapshot
  events: readonly LoggedEvent[]
  received: number
}

const EVENT_TONE: Record<string, string> = {
  'turn.start': 'ok',
  'message.delta': 'muted',
  'message.done': 'ok',
  'tool.call': 'accent',
  'tool.result': 'accent',
  'turn.end': 'ok',
  error: 'error',
  ping: 'muted',
}

export function Inspector({ snapshot, events, received }: InspectorProps) {
  const live = snapshot.live
  const tools = live?.toolCalls ?? snapshot.messages.flatMap((message) => message.toolCalls)

  return (
    <aside className="inspector">
      <section className="panel">
        <h2>会话状态</h2>
        <dl className="kv">
          <div>
            <dt>传输</dt>
            <dd data-testid="inspector-status">{snapshot.status}</dd>
          </div>
          <div>
            <dt>回合</dt>
            <dd>{live ? (live.status === 'running' ? '进行中' : live.status) : '空闲'}</dd>
          </div>
          <div>
            <dt>turnId</dt>
            <dd className="mono">{live?.turnId ?? '—'}</dd>
          </div>
          <div>
            <dt>内容片段</dt>
            <dd>{live?.parts.length ?? 0}</dd>
          </div>
          <div>
            <dt>已收事件</dt>
            <dd>{received}</dd>
          </div>
          <div>
            <dt>重连</dt>
            <dd>
              {snapshot.reconnect
                ? `第 ${snapshot.reconnect.attempt} 次 · ${snapshot.reconnect.delayMs}ms`
                : '—'}
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>工具调用</h2>
        {tools.length === 0 ? (
          <p className="empty">本轮还没有工具调用</p>
        ) : (
          <ul className="tools">
            {tools.map((tool) => (
              <li key={tool.callId} className={`tool-row tool-row--${tool.status}`}>
                <span className="tool-name mono">{tool.name}</span>
                <span className="tool-meta">
                  {tool.status}
                  {tool.durationMs !== undefined ? ` · ${Math.round(tool.durationMs)}ms` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel panel--log">
        <h2>事件流</h2>
        <ol className="log">
          {events.length === 0 && <li className="empty">等待事件…</li>}
          {events.map((event) => (
            <li key={`${event.seq}-${event.at}`} className={`log-row log-row--${EVENT_TONE[event.type] ?? 'muted'}`}>
              <span className="log-seq">{event.seq}</span>
              <span className="log-type mono">{event.type}</span>
            </li>
          ))}
        </ol>
      </section>
    </aside>
  )
}
