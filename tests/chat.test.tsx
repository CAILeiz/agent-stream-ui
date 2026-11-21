import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentChat } from '../src/lib/react/agent-chat'
import { createAgentStream } from '../src/lib/core/store'
import { immediateScheduler } from '../src/lib/core/scheduler'
import { formatSseFrame, parseSseChunk } from '../src/lib/sse/frame'
import type { ScriptedChunk, Transport } from '../src/lib/core/transport'

/** 测试用传输：手动推帧，时序完全可控。 */
function createManualTransport() {
  let ctx: Parameters<Transport['open']>[0] | null = null

  const transport: Transport = {
    open(context) {
      ctx = context
      context.onStatus('open', { attempt: 0, delayMs: 0 })
    },
  }

  return {
    transport,
    push(event: string, data: unknown, id?: number) {
      const frame = formatSseFrame({
        id: id ?? null,
        event,
        data: JSON.stringify(data),
      })
      // 用分帧器走一遍，确保和真实路径一致
      for (const parsed of parseSseChunk(frame).frames) ctx?.onFrame(parsed)
    },
    status(status: 'reconnecting' | 'closed' | 'error') {
      ctx?.onStatus(status, { attempt: 1, delayMs: 500 })
    },
    get opened() {
      return ctx !== null
    },
  }
}

function makeStore() {
  const manual = createManualTransport()
  const store = createAgentStream({
    transport: manual.transport,
    scheduler: immediateScheduler,
    now: () => 1_700_000_000_000,
  })
  return { store, manual }
}

describe('AgentChat', () => {
  it('发送后先出现用户消息，再流式出现回答', async () => {
    const user = userEvent.setup()
    const { store, manual } = makeStore()

    render(<AgentChat store={store} />)

    await user.type(screen.getByLabelText('输入消息'), '你好{Enter}')
    expect(screen.getByTestId('message-user')).toHaveTextContent('你好')

    await act(async () => {
      manual.push('turn.start', { turnId: 't1' })
      manual.push('message.delta', { text: '在的' })
    })

    expect(screen.getByTestId('message-live')).toHaveTextContent('在的')
  })

  it('工具调用渲染成卡片，结果到达后状态更新', async () => {
    const user = userEvent.setup()
    const { store, manual } = makeStore()
    render(<AgentChat store={store} />)

    await user.type(screen.getByLabelText('输入消息'), '查一下{Enter}')

    await act(async () => {
      manual.push('turn.start', { turnId: 't1' })
      manual.push('tool.call', { callId: 'c1', name: 'search_projects', arguments: '{"q":"x"' })
    })

    const card = screen.getByTestId('tool-call-card')
    expect(card).toHaveAttribute('data-status', 'running')
    expect(card).toHaveTextContent('search_projects')

    await act(async () => {
      manual.push('tool.result', { callId: 'c1', ok: true, preview: '命中 2 条', durationMs: 120 })
    })

    expect(screen.getByTestId('tool-call-card')).toHaveAttribute('data-status', 'ok')

    // 展开后能看到入参与结果
    await user.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByTestId('tool-preview')).toHaveTextContent('命中 2 条')
  })

  it('停止按钮在生成中可用，停止后保留内容并清空 live', async () => {
    const user = userEvent.setup()
    const { store, manual } = makeStore()
    render(<AgentChat store={store} />)

    await user.type(screen.getByLabelText('输入消息'), '长回答{Enter}')
    await act(async () => {
      manual.push('turn.start', { turnId: 't1' })
      manual.push('message.delta', { text: '已经写的部分' })
    })

    await user.click(screen.getByLabelText('停止生成'))

    await waitFor(() => expect(screen.queryByTestId('message-live')).toBeNull())
    expect(screen.getAllByTestId('message-assistant')[0]).toHaveTextContent('已经写的部分')
    expect(store.getSnapshot().messages.at(-1)?.status).toBe('stopped')
  })

  it('错误态展示重试入口，重试会重新发起请求', async () => {
    const user = userEvent.setup()
    const openSpy = vi.fn()
    const manual = createManualTransport()
    const transport: Transport = {
      open(context) {
        openSpy(context.text)
        manual.transport.open(context)
      },
    }
    const store = createAgentStream({ transport, scheduler: immediateScheduler })

    render(<AgentChat store={store} />)
    await user.type(screen.getByLabelText('输入消息'), '会失败的问题{Enter}')
    expect(openSpy).toHaveBeenCalledTimes(1)

    await act(async () => {
      manual.push('turn.start', { turnId: 't1' })
      manual.push('message.delta', { text: '半截' })
      manual.push('error', { message: '上游超时', stage: 'generate', retriable: true })
    })

    expect(screen.getByRole('alert')).toHaveTextContent('上游超时')

    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(openSpy).toHaveBeenCalledTimes(2)
    expect(openSpy.mock.calls[1]?.[0]).toBe('会失败的问题')
  })

  it('重连中显示提示，不显示打字光标', async () => {
    const user = userEvent.setup()
    const { store, manual } = makeStore()
    render(<AgentChat store={store} />)

    await user.type(screen.getByLabelText('输入消息'), 'hi{Enter}')
    await act(async () => {
      manual.push('turn.start', { turnId: 't1' })
      manual.push('message.delta', { text: '内容' })
      manual.status('reconnecting')
    })

    expect(screen.getByTestId('interrupted-hint')).toBeInTheDocument()
    expect(screen.getByTestId('status-badge')).toHaveTextContent('重连中')
  })

  it('Enter 发送、Shift+Enter 换行', async () => {
    const user = userEvent.setup()
    const { store } = makeStore()
    render(<AgentChat store={store} />)

    const input = screen.getByLabelText('输入消息')
    await user.type(input, '第一行{Shift>}{Enter}{/Shift}第二行')
    expect(input).toHaveValue('第一行\n第二行')
    expect(screen.queryByTestId('message-user')).toBeNull()

    await user.type(input, '{Enter}')
    expect(screen.getByTestId('message-user')).toHaveTextContent('第一行 第二行')
  })
})

describe('scripted transport contract', () => {
  it('脚本帧能被分帧器完整还原（与真实 SSE 同形）', async () => {
    const { buildDemoScript } = await import('../src/demo/script')
    const { parseSseChunk } = await import('../src/lib/sse/frame')
    const script = buildDemoScript()

    const events = script.chunks.flatMap((chunk: ScriptedChunk) => parseSseChunk(chunk.chunk).frames)
    expect(events.length).toBe(script.chunks.length)
    expect(events[0]?.event).toBe('turn.start')
    expect(events.at(-1)?.event).toBe('turn.end')
    expect(events.every((frame) => frame.id !== null)).toBe(true)
  })
})
