import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AgentChat,
  createAgentStream,
  createHttpTransport,
  createScriptedTransport,
  useAgentStream,
} from '../lib'
import type { AgentEvent, AgentStreamStore, SseFrame } from '../lib'
import { buildDemoScript, buildFailureScript } from './script'
import { Inspector, type LoggedEvent } from './inspector'

type Mode = 'script' | 'http'

/** 指向任意实现了同一事件协议的服务端（见 examples/openai-compatible）。 */
const STREAM_URL = (import.meta.env.VITE_STREAM_URL as string | undefined) ?? '/api/chat'

const SUGGESTIONS = [
  '流式渲染怎么避免每次都重新 parse markdown？',
  '为什么不用 WebSocket？',
  '工具参数只到一半，界面怎么处理？',
]

/** 事件日志按 250ms 批量刷新，避免"日志组件"把流式性能吃掉。 */
function useEventLog() {
  const [events, setEvents] = useState<LoggedEvent[]>([])
  const [received, setReceived] = useState(0)
  const bufferRef = useRef<LoggedEvent[]>([])
  const allRef = useRef<LoggedEvent[]>([])

  useEffect(() => {
    const timer = setInterval(() => {
      if (bufferRef.current.length === 0) return
      allRef.current = [...allRef.current, ...bufferRef.current].slice(-200)
      bufferRef.current = []
      setEvents(allRef.current.slice(-14).reverse())
      setReceived(allRef.current.length)
    }, 250)
    return () => clearInterval(timer)
  }, [])

  const push = useCallback((event: AgentEvent, frame: SseFrame) => {
    bufferRef.current.push({
      seq: frame.id ?? '·',
      type: event.type,
      at: Date.now(),
    })
  }, [])

  const reset = useCallback(() => {
    bufferRef.current = []
    allRef.current = []
    setEvents([])
    setReceived(0)
  }, [])

  return { events, received, push, reset }
}

export function App() {
  const params = new URLSearchParams(window.location.search)
  const [mode, setMode] = useState<Mode>(
    params.has('mock') ? 'script' : import.meta.env.DEV ? 'http' : 'script',
  )
  const [flaky, setFlaky] = useState(params.has('flaky'))
  const [failure, setFailure] = useState(params.has('failure'))
  const [theme, setTheme] = useState<'dark' | 'light'>(
    params.get('theme') === 'light' ? 'light' : 'dark',
  )

  const { events, received, push, reset } = useEventLog()

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // 切换模式/故障注入时重建 store：演示要能反复来
  useEffect(() => {
    reset()
  }, [mode, flaky, failure, reset])

  const store = useMemo<AgentStreamStore>(() => {
    if (mode === 'http') {
      return createAgentStream({
        transport: createHttpTransport({
          url: STREAM_URL,
          // 演示里把看门狗调紧：代理挂住死连接时，2.5s 内没帧就重连
          idleTimeoutMs: 2500,
          buildBody: ({ text, history }) => ({
            text,
            history,
            flaky: flaky || failure,
          }),
        }),
        onEvent: push,
      })
    }

    const script = failure ? buildFailureScript() : buildDemoScript()
    return createAgentStream({
      transport: createScriptedTransport(script.chunks, {
        dropAfterChunk: flaky ? 3 : -1,
      }),
      onEvent: push,
    })
  }, [mode, flaky, failure, push])

  const snapshot = useAgentStream(store)

  // 截图 / 演示用：`?auto=1` 自动发一条消息，省得每次手点
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('auto')) return
    const timer = setTimeout(() => store.send('流式渲染怎么做才不会卡？'), 260)
    return () => clearTimeout(timer)
  }, [store])


  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">agent-stream-ui</p>
          <h1>流式 Agent 界面运行时</h1>
          <p className="lede">
            SSE 分帧 · 断点续传 · 增量 Markdown · 工具调用卡 · 一帧一次渲染。右边是真实状态机，不是示意。
          </p>
        </div>

        <div className="controls">
          <div className="segmented" role="group" aria-label="传输模式">
            <button
              type="button"
              className={mode === 'http' ? 'is-active' : ''}
              onClick={() => setMode('http')}
            >
              真实 SSE
            </button>
            <button
              type="button"
              className={mode === 'script' ? 'is-active' : ''}
              onClick={() => setMode('script')}
            >
              脚本回放
            </button>
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={flaky}
              onChange={(event) => setFlaky(event.target.checked)}
            />
            <span>模拟断流</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={failure}
              onChange={(event) => setFailure(event.target.checked)}
            />
            <span>失败演示</span>
          </label>

          <button
            type="button"
            className="ghost"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? '浅色' : '深色'}
          </button>
        </div>
      </header>

      <main className="layout">
        <div className="chat-slot">
          <AgentChat
            store={store}
            title="Agent 控制台"
            subtitle={
              mode === 'http' ? 'POST /api/chat · text/event-stream' : '本地脚本回放 · 无网络'
            }
            suggestions={SUGGESTIONS}
            placeholder="问点什么…"
            footer={
              <p className="footnote">
                停止会保留已生成内容；断流后自动带 <code>Last-Event-ID</code> 续传；工具卡点标题可展开。
              </p>
            }
          />
        </div>

        <Inspector snapshot={snapshot} events={events} received={received} />
      </main>
    </div>
  )
}
