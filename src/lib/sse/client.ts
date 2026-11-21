/**
 * SSE 客户端：`POST + text/event-stream`，带退避重连、`Last-Event-ID` 续传与游标去重。
 *
 * 三条不写在明面上的约定，都是踩过坑才有的：
 * 1. **只对"可能自愈"的失败重连**：5xx / 408 / 429 / 网络中断。4xx（会话不存在、
 *    未登录、已裁决）重连只会空转，直接停在 error。
 * 2. **重连必须带游标**：服务端按 `Last-Event-ID` 从之后重放，客户端再按 id 去重，
 *    这样"断在半个 token 中间"也能接到正确位置。
 * 3. **停止是本地语义**：abort 之后不再重连，也不抛错——用户主动停的不是失败。
 */

import type { SseStatus, SseStatusInfo } from '../types'
import { isNewerEventId, parseSseChunk } from './frame'
import type { SseFrame } from './frame'

export const DEFAULT_BACKOFF_BASE_MS = 500
export const DEFAULT_BACKOFF_FACTOR = 2
export const DEFAULT_BACKOFF_MAX_MS = 7_000
export const DEFAULT_MAX_ATTEMPTS = 8

export interface SseClientOptions {
  url: string
  method?: 'POST' | 'GET'
  headers?: Record<string, string>
  body?: unknown
  /** 断点续传游标；null 表示从头开始。 */
  lastEventId?: string | null
  backoffBaseMs?: number
  backoffFactor?: number
  backoffMaxMs?: number
  /** 连续失败上限，超过就停在 error，避免无限重连。 */
  maxAttempts?: number
  /**
   * 空闲超时：超过这么久没收到任何帧就主动断开重连。
   *
   * 半开连接（NAT 超时、LB 静默丢包、代理挂住上游）在 TCP 层看起来是"还活着"，
   * 读操作永远不会返回。没有这个看门狗，界面会永远停在"生成中"。
   * 默认关闭（0）：不同业务的首帧延迟差异太大，交给使用方决定。
   */
  idleTimeoutMs?: number
  /** 覆盖默认的可重试判定。 */
  isRetriable?: (ctx: RetryContext) => boolean
  /** 注入 fetch（测试/非浏览器环境用）。 */
  fetch?: typeof fetch
  onStatus?: (status: SseStatus, info?: SseStatusInfo) => void
  onEvent: (frame: SseFrame) => void
  /** 上一次处理过的游标，用于跨重连去重。 */
  getCursor?: () => string | null
}

export interface RetryContext {
  /** HTTP 状态码；网络错误时为 0。 */
  status: number
  attempt: number
}

export interface SseClient {
  /** 主动停止：abort 在途请求并禁止后续重连。 */
  close: () => void
  /** 当前状态快照（同步读，不触发回调）。 */
  readonly status: SseStatus
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * 带空闲看门狗的读。超时后取消 reader 并抛错，交给外层重连。
 * 没有它，被代理挂住的半开连接会让 UI 永远停在"生成中"。
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (idleTimeoutMs <= 0) return reader.read()

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('idle timeout')), idleTimeoutMs)
  })

  try {
    return await Promise.race([reader.read(), timeout])
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function shouldRetryStatus(status: number): boolean {
  if (status === 0) return true // 网络层错误
  if (status === 408 || status === 429) return true
  return status >= 500
}

export function computeBackoff(
  attempt: number,
  base = DEFAULT_BACKOFF_BASE_MS,
  factor = DEFAULT_BACKOFF_FACTOR,
  max = DEFAULT_BACKOFF_MAX_MS,
): number {
  return Math.min(base * factor ** Math.max(0, attempt - 1), max)
}

export function createSseClient(options: SseClientOptions): SseClient {
  const {
    url,
    method = 'POST',
    headers = {},
    body,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    backoffFactor = DEFAULT_BACKOFF_FACTOR,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    idleTimeoutMs = 0,
    isRetriable = (ctx: RetryContext) => shouldRetryStatus(ctx.status),
    fetch: fetchImpl = globalThis.fetch,
    onStatus = () => {},
    onEvent,
    getCursor = () => null,
  } = options

  const abort = new AbortController()
  let status: SseStatus = 'idle'
  let attempt = 0
  let lastEventId = options.lastEventId ?? null

  const setStatus = (next: SseStatus, info?: SseStatusInfo) => {
    status = next
    onStatus(next, info)
  }

  const consume = async (response: Response) => {
    if (!response.body) throw new Error('response has no body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs)
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const { frames, rest } = parseSseChunk(buffer)
      buffer = rest

      for (const frame of frames) {
        if (frame.id !== null) {
          // 跨重连去重：服务端可能重放边界帧
          if (!isNewerEventId(frame.id, getCursor() ?? lastEventId)) continue
          lastEventId = frame.id
        }
        onEvent(frame)
      }
    }

    // 流被服务端正常关闭（reader done）：收拾残余并用非流式解码收尾
    buffer += decoder.decode()
    if (buffer.trim() !== '') {
      const { frames } = parseSseChunk(`${buffer}\n\n`)
      for (const frame of frames) {
        if (frame.id !== null && !isNewerEventId(frame.id, getCursor() ?? lastEventId)) continue
        if (frame.id !== null) lastEventId = frame.id
        onEvent(frame)
      }
    }
  }

  const run = async () => {
    while (!abort.signal.aborted) {
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting', {
        attempt,
        delayMs: 0,
      })

      try {
        const requestHeaders: Record<string, string> = {
          accept: 'text/event-stream',
          ...headers,
        }
        if (body !== undefined && method !== 'GET') {
          requestHeaders['content-type'] = 'application/json'
        }
        if (lastEventId !== null) {
          requestHeaders['last-event-id'] = lastEventId
        }

        const response = await fetchImpl(url, {
          method,
          headers: requestHeaders,
          body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
          signal: abort.signal,
          cache: 'no-store',
        })

        if (abort.signal.aborted) return

        if (!response.ok) {
          const reason = `HTTP ${response.status}`
          const retriable = isRetriable({ status: response.status, attempt })
          if (!retriable) {
            setStatus('error', { attempt, delayMs: 0, reason })
            return
          }
          throw new Error(reason)
        }

        attempt = 0
        setStatus('open', { attempt: 0, delayMs: 0 })
        await consume(response)

        if (abort.signal.aborted) return

        // 干净的 EOF 也是"没等到 turn.end 就断了"：不能当成正常结束。
        // 真正的结束由使用方在看到 turn.end 后调用 close() 表示。
        throw new Error('stream ended before turn.end')
      } catch (error) {
        if (abort.signal.aborted) return

        attempt += 1
        const delayMs = computeBackoff(attempt, backoffBaseMs, backoffFactor, backoffMaxMs)
        const reason = error instanceof Error ? error.message : String(error)
        const retriable =
          isRetriable({ status: 0, attempt }) && attempt <= maxAttempts
        if (!retriable) {
          setStatus('error', { attempt, delayMs: 0, reason })
          return
        }

        setStatus('reconnecting', { attempt, delayMs, reason })
        await sleep(delayMs, abort.signal)
      }
    }
  }

  void run()

  return {
    close() {
      if (abort.signal.aborted) return
      abort.abort()
      setStatus('stopped', { attempt, delayMs: 0, reason: 'aborted-by-user' })
    },
    get status() {
      return status
    },
  }
}
