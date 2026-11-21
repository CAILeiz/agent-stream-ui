/**
 * 会话 store：把 transport 的事件折叠成快照，并做「一帧一次」的通知。
 *
 * 为什么不用 `useState` 直接接事件：流式场景下一步事件就是一次 setState，
 * 一秒钟几十次，React 会把时间全花在重复渲染上。这里的做法是
 * **状态立刻更新、通知按帧合并**——getSnapshot 永远返回最新状态，
 * 订阅者每帧最多被叫醒一次。
 */

import type {
  AgentEvent,
  ConversationSnapshot,
  Message,
  SseStatus,
  SseStatusInfo,
} from '../types'
import type { SseFrame } from '../sse/frame'
import type { Transport } from './transport'
import type { FlushScheduler } from './scheduler'
import { defaultScheduler } from './scheduler'
import {
  appendUserMessage,
  applySseStatus,
  decodeAgentEvent,
  initialLiveTurn,
  initialSnapshot,
  reduceAgentEvent,
  settleOrphanLiveTurn,
  stopLiveTurn,
} from './reducer'

export interface AgentStreamOptions {
  transport: Transport
  scheduler?: FlushScheduler
  now?: () => number
  /** 调试钩子：每个被识别的事件（含 ping）都会回调一次。 */
  onEvent?: (event: AgentEvent, frame: SseFrame) => void
}

export interface AgentStreamStore {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => ConversationSnapshot
  readonly send: (text: string) => void
  readonly stop: () => void
  readonly retry: () => void
  readonly reset: () => void
}

export function createAgentStream(options: AgentStreamOptions): AgentStreamStore {
  const { transport, now = Date.now, onEvent } = options
  const scheduler = options.scheduler ?? defaultScheduler()

  let snapshot = initialSnapshot()
  let controller: AbortController | null = null
  let pending: unknown = null
  let scheduled = false
  const listeners = new Set<() => void>()

  const notify = () => {
    scheduled = false
    pending = null
    for (const listener of [...listeners]) listener()
  }

  /** 合并一帧内的多次状态变更；scheduler 保证 notify 每帧最多一次。 */
  const scheduleFlush = () => {
    if (scheduled) return
    scheduled = true
    pending = scheduler.schedule(notify)
  }

  const cancelFlush = () => {
    if (!scheduled) return
    scheduler.cancel(pending)
    scheduled = false
    pending = null
  }

  const closeTransport = () => {
    controller?.abort()
    controller = null
  }

  const handleStatus = (status: SseStatus, info?: SseStatusInfo) => {
    // 已经收尾的回合不要再被 "stopped" 覆盖（那是我们自己 abort 引发的）
    if (status === 'stopped' && snapshot.live === null) return

    snapshot = applySseStatus(snapshot, status, info)

    // 服务端把流关了但没发 turn.end（或重连耗尽）：不能让它永远转圈
    if (
      (status === 'closed' || status === 'error') &&
      snapshot.live &&
      snapshot.live.status === 'running'
    ) {
      snapshot = settleOrphanLiveTurn(snapshot, now())
    }

    scheduleFlush()
  }

  const handleFrame = (frame: SseFrame) => {
    const event = decodeAgentEvent(frame.event, frame.data)
    if (!event) return

    onEvent?.(event, frame)
    snapshot = reduceAgentEvent(snapshot, event, now())
    scheduleFlush()

    if (event.type === 'turn.end') {
      snapshot = { ...snapshot, status: 'closed' }
      scheduleFlush()
      // 回合已结束，主动关流，避免服务端保持长连接
      closeTransport()
    }
  }

  const openTransport = (text: string, history: readonly Message[]) => {
    closeTransport()
    const next = new AbortController()
    controller = next

    transport.open({
      text,
      history,
      signal: next.signal,
      onFrame: handleFrame,
      onStatus: handleStatus,
    })
  }

  const store: AgentStreamStore = {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    getSnapshot() {
      return snapshot
    },

    send(text) {
      const live = snapshot.live
      if (live && live.status === 'running') return

      const trimmed = text.trim()
      if (trimmed === '') return

      const at = now()
      const history = snapshot.messages

      snapshot = appendUserMessage({ ...snapshot, live: null }, trimmed, at)
      snapshot = {
        ...snapshot,
        live: initialLiveTurn(at),
        status: 'connecting',
        reconnect: null,
      }
      scheduleFlush()

      openTransport(trimmed, history)
    },

    stop() {
      if (snapshot.live) {
        snapshot = stopLiveTurn(snapshot, now())
        scheduleFlush()
      }
      closeTransport()
    },

    retry() {
      const failed = snapshot.live
      const canRetry =
        (failed && failed.status === 'error') ||
        snapshot.status === 'error' ||
        snapshot.messages.at(-1)?.status === 'error'
      if (!canRetry) return

      const lastUser = [...snapshot.messages].reverse().find((item) => item.role === 'user')
      if (!lastUser) return

      const text = lastUser.parts
        .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
        .map((part) => part.text)
        .join('\n')

      const index = snapshot.messages.lastIndexOf(lastUser)
      const history = snapshot.messages.slice(0, index)

      const at = now()
      snapshot = {
        ...snapshot,
        live: initialLiveTurn(at),
        status: 'connecting',
        reconnect: null,
      }
      scheduleFlush()

      openTransport(text, history)
    },

    reset() {
      closeTransport()
      cancelFlush()
      snapshot = initialSnapshot()
      scheduleFlush()
    },
  }

  return store
}
