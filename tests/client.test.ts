import { describe, expect, it, vi } from 'vitest'
import { createSseClient } from '../src/lib/sse/client'
import type { SseClient } from '../src/lib/sse/client'
import type { SseFrame } from '../src/lib/sse/frame'

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function responseOf(chunks: readonly string[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: streamOf(chunks),
  } as unknown as Response
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function frameText(id: number, data: string): string {
  return `id: ${id}\ndata: ${data}\n\n`
}

describe('createSseClient', () => {
  it('逐帧回调并按顺序更新游标', async () => {
    const frames: SseFrame[] = []
    const fetchMock = vi.fn(async () =>
      responseOf([frameText(1, '{"a":1}'), frameText(2, '{"a":2}')]),
    )

    const client = createSseClient({
      url: '/api/chat',
      body: { text: 'hi' },
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: (frame) => frames.push(frame),
    })

    await waitFor(() => frames.length === 2)
    expect(frames.map((frame) => frame.id)).toEqual(['1', '2'])
    client.close()
  })

  it('断流后带 Last-Event-ID 重连，并去重重放帧', async () => {
    const frames: SseFrame[] = []
    const seenHeaders: Array<Record<string, string>> = []

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seenHeaders.push((init?.headers ?? {}) as Record<string, string>)
      if (fetchMock.mock.calls.length === 1) {
        // 第一段：发到 id=2 就断（服务端 EOF，没有 turn.end）
        return responseOf([frameText(1, '{"t":"a"}'), frameText(2, '{"t":"b"}')])
      }
      // 第二段：服务端从 id=1 重放（含重复帧），再发新帧
      return responseOf([
        frameText(1, '{"t":"a"}'),
        frameText(2, '{"t":"b"}'),
        frameText(3, '{"t":"c"}'),
      ])
    })

    const client = createSseClient({
      url: '/api/chat',
      body: { text: 'hi' },
      fetch: fetchMock as unknown as typeof fetch,
      backoffBaseMs: 1,
      onEvent: (frame) => frames.push(frame),
    })

    await waitFor(() => frames.length === 3, 3000)

    expect(frames.map((frame) => frame.data)).toEqual(['{"t":"a"}', '{"t":"b"}', '{"t":"c"}'])
    expect(seenHeaders[1]?.['last-event-id']).toBe('2')
    expect(seenHeaders[1]?.['content-type']).toBe('application/json')
    client.close()
  })

  it('4xx 不重连，直接进入 error', async () => {
    const onStatus = vi.fn()
    const fetchMock = vi.fn(async () => responseOf([], 401))

    const client = createSseClient({
      url: '/api/chat',
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: () => {},
      onStatus,
    })

    await waitFor(() => onStatus.mock.calls.some(([status]) => status === 'error'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenLastCalledWith(
      'error',
      expect.objectContaining({ reason: 'HTTP 401' }),
    )
    client.close()
  })

  it('5xx 会退避重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responseOf([], 503))
      .mockResolvedValueOnce(responseOf([frameText(1, '{"ok":true}')]))

    const frames: SseFrame[] = []
    const client = createSseClient({
      url: '/api/chat',
      fetch: fetchMock as unknown as typeof fetch,
      backoffBaseMs: 1,
      onEvent: (frame) => frames.push(frame),
    })

    await waitFor(() => frames.length === 1, 3000)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    client.close()
  })

  it('空闲超时（半开连接）会主动重连', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        // 一个永远不产出、也不关闭的流：模拟被代理挂住的连接
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({ start() {} }),
        } as unknown as Response
      }
      return responseOf([frameText(1, '{"ok":true}')])
    })

    const frames: SseFrame[] = []
    const client = createSseClient({
      url: '/api/chat',
      fetch: fetchMock as unknown as typeof fetch,
      idleTimeoutMs: 20,
      backoffBaseMs: 1,
      onEvent: (frame) => frames.push(frame),
    })

    await waitFor(() => frames.length === 1, 3000)
    expect(calls).toBeGreaterThanOrEqual(2)
    client.close()
  })

  it('close() 之后不再重连', async () => {
    const fetchMock = vi.fn(async () => responseOf([]))
    const onStatus = vi.fn()

    const client: SseClient = createSseClient({
      url: '/api/chat',
      fetch: fetchMock as unknown as typeof fetch,
      backoffBaseMs: 1,
      onEvent: () => {},
      onStatus,
    })

    await waitFor(() => fetchMock.mock.calls.length >= 1)
    client.close()

    const calls = fetchMock.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.status).toBe('stopped')
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it('连续失败超过上限后停在 error', async () => {
    const onStatus = vi.fn()
    const fetchMock = vi.fn(async () => responseOf([], 500))

    const client = createSseClient({
      url: '/api/chat',
      fetch: fetchMock as unknown as typeof fetch,
      backoffBaseMs: 1,
      maxAttempts: 2,
      onEvent: () => {},
      onStatus,
    })

    await waitFor(() => onStatus.mock.calls.some(([status]) => status === 'error'), 3000)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3)
    client.close()
  })
})
