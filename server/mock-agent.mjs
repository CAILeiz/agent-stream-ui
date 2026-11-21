/**
 * 本地 mock Agent 服务：只做一件事——把一段回答按 SSE 吐出来。
 *
 * 刻意保留的能力：
 * - 按 `Last-Event-ID` 断点续传（会话内 outbox 游标）；
 * - `flaky: true` 时在第 3 帧后直接掐断连接，用来演示前端重连；
 * - 帧 id 单调递增，前端可据此去重。
 *
 * 它不是产品代码，但和真实服务端的协议形状一致。
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.PORT ?? 8787)

/** clientTurnId -> { frames, cursor } */
const sessions = new Map()

const OPENING = '收到。我先查一下相关资料，再给结论。\n\n'

const ANSWER = `## 结论

流式 Agent 界面的难点不在"把字打出来"，而在**三个不确定性**：内容不确定、结构不确定、连接不确定。

1. **内容**：文本逐 token 到达，Markdown 结构随时可能被改写；
2. **结构**：工具参数边生成边到达，JSON 可能长期残缺；
3. **连接**：长连接会断，重连必须从正确位置继续。

分层处理：传输层只管"可靠拿到帧"，reducer 只管"折叠成状态"，组件只管"画状态"。

\`\`\`ts
const client = createSseClient({ url, method: 'POST', body, onEvent })
const next = reduceAgentEvent(state, event)
\`\`\`

> 界面不应该知道 token 长什么样，它只应该认识事件。

### 下一步

- 工具卡抽成可注册渲染器（Generative UI 的入口）
- 章节级重试，而不是整轮重跑
- 接真实模型，量首字延迟与每秒帧数`

const TOOL_ARGS =
  '{"query":"agent streaming ui react","topK":5,"recency":"2026"}'

function sse(id, event, data) {
  let out = `id: ${id}\n`
  if (event) out += `event: ${event}\n`
  for (const line of JSON.stringify(data).split('\n')) out += `data: ${line}\n`
  return `${out}\n`
}

function splitForStreaming(text, size = 14) {
  const chunks = []
  let cursor = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const shouldCut =
      index - cursor >= size || '。！？；\n'.includes(char) || (char === ',' && index - cursor >= 8)
    if (shouldCut) {
      chunks.push(text.slice(cursor, index + 1))
      cursor = index + 1
    }
  }
  if (cursor < text.length) chunks.push(text.slice(cursor))
  return chunks.filter(Boolean)
}

function buildFrames(turnId) {
  const frames = []
  let id = 0
  const push = (event, data, delayMs) => {
    id += 1
    frames.push({ id, text: sse(id, event, data), delayMs })
  }

  push('turn.start', { turnId }, 160)

  for (const piece of splitForStreaming(OPENING)) {
    push('message.delta', { text: piece }, 24)
  }

  push('tool.call', { callId: 'call_1', name: 'search_projects', arguments: TOOL_ARGS }, 340)

  push(
    'tool.result',
    {
      callId: 'call_1',
      ok: true,
      durationMs: 842,
      preview: '命中 3 个仓：vercel/ai（18.2k★）、assistant-ui（9.4k★）、copilotkit（12.1k★）',
    },
    620,
  )

  for (const piece of splitForStreaming(ANSWER)) {
    push('message.delta', { text: piece }, 24)
  }

  push('turn.end', { reason: 'complete' }, 160)

  return frames
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, last-event-id',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
    })
    res.end()
    return
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, sessions: sessions.size })
    return
  }

  if (url.pathname !== '/api/chat' || req.method !== 'POST') {
    sendJson(res, 404, { error: 'not_found' })
    return
  }

  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    sendJson(res, 400, { error: 'invalid_json' })
    return
  }

  const clientTurnId = typeof body.clientTurnId === 'string' ? body.clientTurnId : randomUUID()
  const flaky = body.flaky === true

  if (!sessions.has(clientTurnId)) {
    sessions.set(clientTurnId, {
      turnId: `turn_${clientTurnId.slice(0, 8)}`,
      frames: null,
      cursor: 0,
    })
  }
  const session = sessions.get(clientTurnId)
  session.frames ??= buildFrames(session.turnId)

  const lastEventId = Number(req.headers['last-event-id'] ?? 0)
  if (Number.isFinite(lastEventId) && lastEventId > session.cursor) {
    session.cursor = lastEventId
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  })
  // 让代理/浏览器立刻开始接收，而不是等第一个数据块
  res.write(': connected\n\n')

  let closed = false
  const pending = []
  req.on('close', () => {
    closed = true
    for (const timer of pending) clearTimeout(timer)
  })

  let sentThisConnection = 0

  const pump = () => {
    if (closed) return

    const next = session.frames.find((frame) => frame.id > session.cursor)
    if (!next) {
      res.end()
      sessions.delete(clientTurnId)
      return
    }

    if (flaky && !session.dropped && sentThisConnection >= 3) {
      // 只掐一次：模拟"网络闪断一次，之后恢复"，
      // 否则每次重连都在同一位置再断，看起来像死循环。
      session.dropped = true
      closed = true
      req.socket.destroy()
      return
    }

    session.cursor = next.id
    sentThisConnection += 1
    res.write(next.text)

    const timer = setTimeout(pump, next.delayMs)
    pending.push(timer)
  }

  const startDelay = setTimeout(pump, 120)
  pending.push(startDelay)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-agent] listening on http://127.0.0.1:${PORT}`)
  console.log('[mock-agent] POST /api/chat  { text, flaky? }')
})
