import { describe, expect, it } from 'vitest'
import { createAgentStream } from '../src/lib/core/store'
import { createHttpTransport } from '../src/lib/core/transport'
import { immediateScheduler } from '../src/lib/core/scheduler'
import { formatSseFrame } from '../src/lib/sse/frame'
import type { ConversationSnapshot } from '../src/lib/types'

/**
 * 断流一致性：同一段对话，断流重连 1 次 vs 一次跑完，
 * 最终的渲染状态必须**逐字段一致**——不是"看起来差不多"。
 */

const EVENTS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['turn.start', { turnId: 't1' }],
  ['message.delta', { text: '结论：' }],
  ['message.delta', { text: '三个不确定性。' }],
  ['tool.call', { callId: 'c1', name: 'search', arguments: '{"q":"x"}' }],
  ['tool.result', { callId: 'c1', ok: true, durationMs: 12, preview: '3 hits' }],
  ['message.delta', { text: '\n\n- 内容\n- 结构\n- 连接' }],
  ['turn.end', { reason: 'complete' }],
]

function frames(from: number, to: number): string {
  return EVENTS.slice(from - 1, to)
    .map(([event, data], index) =>
      formatSseFrame({ id: from + index, event, data: JSON.stringify(data) }),
    )
    .join('')
}

function responseOf(text: string): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  return { ok: true, status: 200, body } as unknown as Response
}

function makeFetch(chunksPerCall: readonly string[]) {
  let call = 0
  return async () => {
    const chunk = chunksPerCall[Math.min(call, chunksPerCall.length - 1)] ?? ''
    call += 1
    return responseOf(chunk)
  }
}

async function runUntilDone(fetchImpl: typeof fetch): Promise<ConversationSnapshot> {
  const store = createAgentStream({
    transport: createHttpTransport({
      url: '/api/chat',
      fetch: fetchImpl,
      backoffBaseMs: 5,
    }),
    scheduler: immediateScheduler,
    now: () => 1_700_000_000_000,
  })

  store.send('问题')

  const started = Date.now()
  while (store.getSnapshot().status !== 'closed') {
    if (Date.now() - started > 5000) throw new Error('timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  return store.getSnapshot()
}

function normalize(snapshot: ConversationSnapshot) {
  return snapshot.messages.map((message) => ({
    role: message.role,
    status: message.status,
    parts: message.parts,
    tools: message.toolCalls.map((tool) => ({
      callId: tool.callId,
      name: tool.name,
      status: tool.status,
      args: tool.args,
      preview: tool.preview,
      durationMs: tool.durationMs,
    })),
    error: message.error ?? null,
  }))
}

describe('断流一致性', () => {
  it('断流重连后的最终状态与一次跑完完全相同', async () => {
    const clean = await runUntilDone(makeFetch([frames(1, 7)]) as unknown as typeof fetch)

    // 第一段只到第 3 帧就 EOF；第二段从第 1 帧重放（模拟网关重发），再补全
    const dropped = await runUntilDone(
      makeFetch([frames(1, 3), frames(1, 7)]) as unknown as typeof fetch,
    )

    expect(normalize(dropped)).toEqual(normalize(clean))
    expect(dropped.messages).toHaveLength(2)
    expect(dropped.messages[1]?.status).toBe('done')
  })

  it('重放的帧不会产生重复文本或重复工具卡', async () => {
    const snapshot = await runUntilDone(
      makeFetch([frames(1, 3), frames(1, 7)]) as unknown as typeof fetch,
    )

    const assistant = snapshot.messages[1]
    const text = assistant?.parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('')

    expect(text).toBe('结论：三个不确定性。\n\n- 内容\n- 结构\n- 连接')
    expect(text?.match(/三个不确定性/g)).toHaveLength(1)
    expect(assistant?.toolCalls).toHaveLength(1)
  })
})
