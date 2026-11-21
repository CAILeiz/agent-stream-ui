/**
 * 传输层抽象。
 *
 * 上层只认 `Transport`，不认 fetch。好处有三个：
 * 1. demo 可以在没有后端时用脚本回放，事件仍然走真实的分帧/折叠路径；
 * 2. 测试可以注入确定性的"服务端"，不用起 HTTP；
 * 3. 真要换成 WebSocket / gRPC / 本地 IPC，只加一个实现，不动 reducer 和组件。
 */

import type { Message, SseStatus, SseStatusInfo } from '../types'
import type { SseFrame } from '../sse/frame'
import { createSseClient } from '../sse/client'
import { parseSseChunk } from '../sse/frame'

export interface TransportOpenContext {
  /** 本轮用户输入。 */
  text: string
  /** 本轮之前的会话历史（不含本轮输入）。 */
  history: readonly Message[]
  signal: AbortSignal
  onFrame: (frame: SseFrame) => void
  onStatus: (status: SseStatus, info?: SseStatusInfo) => void
}

export interface Transport {
  open(context: TransportOpenContext): void
}

export interface HttpTransportOptions {
  url: string
  headers?: Record<string, string>
  /** 自定义请求体，默认 `{ text, history }`。 */
  buildBody?: (context: Pick<TransportOpenContext, 'text' | 'history'>) => unknown
  fetch?: typeof fetch
  /** 空闲多久没帧就判定连接已死并重连；0 = 关闭（默认）。 */
  idleTimeoutMs?: number
  /** 连续失败上限，默认 8。 */
  maxAttempts?: number
  /** 首次重连退避，默认 500ms（测试里会调小）。 */
  backoffBaseMs?: number
}

/** 把消息压成给服务端的纯文本历史，避免把 UI 状态（工具卡）回传。 */
export function toWireHistory(history: readonly Message[]) {
  return history.map((message) => ({
    role: message.role,
    text: message.parts
      .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
      .map((part) => part.text)
      .join('\n'),
  }))
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function createHttpTransport(options: HttpTransportOptions): Transport {
  const {
    url,
    headers,
    fetch: fetchImpl,
    buildBody,
    idleTimeoutMs,
    maxAttempts,
    backoffBaseMs,
  } = options

  return {
    open(context) {
      // 同一个 clientTurnId 会随 SseClient 的重连一起重发，
      // 服务端据此把请求认成"同一轮"并从游标处续传。
      const clientTurnId = randomId()
      const payload = (buildBody ?? defaultBuildBody)({
        text: context.text,
        history: context.history,
      })

      const body =
        payload !== null && typeof payload === 'object' && !Array.isArray(payload)
          ? { clientTurnId, ...(payload as Record<string, unknown>) }
          : payload

      const client = createSseClient({
        url,
        method: 'POST',
        headers,
        body,
        fetch: fetchImpl,
        ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        ...(backoffBaseMs === undefined ? {} : { backoffBaseMs }),
        onEvent: context.onFrame,
        onStatus: context.onStatus,
      })

      context.signal.addEventListener('abort', () => client.close(), { once: true })
    },
  }
}

function defaultBuildBody({
  text,
  history,
}: Pick<TransportOpenContext, 'text' | 'history'>) {
  return { text, history: toWireHistory(history) }
}

/* ------------------------------------------------------------------ *
 * 脚本化传输：没有后端也能演示（GitHub Pages 上也能跑）
 * ------------------------------------------------------------------ */

export interface ScriptedChunk {
  /** 相对上一块的延迟（毫秒）。 */
  delayMs: number
  /** 原始 SSE 文本，必须是完整帧（以空行结尾）。 */
  chunk: string
}

export interface ScriptedTransportOptions {
  /**
   * 在第 N 块之后模拟一次断流：先报 reconnecting，等待一段时间再继续。
   * 用来演示"断点续传"——注意这里仍然是同一条事件流，顺序不变。
   */
  dropAfterChunk?: number
  reconnectDelayMs?: number
}

export function createScriptedTransport(
  script: readonly ScriptedChunk[],
  options: ScriptedTransportOptions = {},
): Transport {
  const { dropAfterChunk = -1, reconnectDelayMs = 1200 } = options

  return {
    open({ signal, onFrame, onStatus }) {
      let index = 0
      let dropped = false

      const schedule = (fn: () => void, delay: number) => {
        if (signal.aborted) return
        timers.push(setTimeout(fn, delay))
      }
      const timers: ReturnType<typeof setTimeout>[] = []

      const cleanup = () => {
        for (const timer of timers) clearTimeout(timer)
        timers.length = 0
      }
      signal.addEventListener('abort', cleanup, { once: true })

      const push = (chunk: string) => {
        const { frames } = parseSseChunk(chunk)
        for (const frame of frames) onFrame(frame)
      }

      const tick = () => {
        if (signal.aborted) return
        const step = script[index]

        if (!step) {
          onStatus('closed', { attempt: 0, delayMs: 0, reason: 'script-finished' })
          cleanup()
          return
        }

        index += 1

        if (!dropped && dropAfterChunk >= 0 && index - 1 === dropAfterChunk) {
          dropped = true
          onStatus('reconnecting', {
            attempt: 1,
            delayMs: reconnectDelayMs,
            reason: 'simulated-disconnect',
          })
          schedule(() => {
            onStatus('open', { attempt: 1, delayMs: 0 })
            tick()
          }, reconnectDelayMs)
          return
        }

        push(step.chunk)
        schedule(tick, step.delayMs)
      }

      onStatus('connecting', { attempt: 0, delayMs: 0 })
      schedule(() => {
        onStatus('open', { attempt: 0, delayMs: 0 })
        tick()
      }, 120)
    },
  }
}
