/**
 * 示例：把一个 OpenAI 兼容的流式接口接到 agent-stream-ui 的事件协议上。
 *
 * 它做三件事：
 * 1. 调上游 `POST /chat/completions`（stream: true），逐 chunk 翻译成本库事件；
 * 2. 遇到 `finish_reason: tool_calls` 时执行工具，把结果塞回对话，再跑一轮；
 * 3. 用 SSE 把事件推给前端——前端不需要知道上游是 OpenAI。
 *
 * 运行：
 *   npm run build:lib
 *   OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-mini node examples/openai-compatible/server.mjs
 * 没有 key 时自动进入 MOCK 模式，用同一套翻译逻辑回放一段录制好的 chunk。
 */

import { createServer } from 'node:http'
import { createOpenAIStreamTranslator } from '../../dist/agent-stream-ui.js'

const PORT = Number(process.env.PORT ?? 8788)
const BASE_URL = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
const API_KEY = process.env.OPENAI_API_KEY ?? ''
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
const MOCK = process.env.MOCK === '1' || API_KEY === ''

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_projects',
      description: '按关键词搜索开源项目，返回名称、star 数与一句话定位',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          topK: { type: 'integer', description: '返回条数，默认 3' },
        },
        required: ['query'],
      },
    },
  },
]

/* ------------------------------------------------------------------ *
 * SSE 输出
 * ------------------------------------------------------------------ */

function writeEvent(res, event) {
  seq += 1
  res.write(
    `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

let seq = 0

/* ------------------------------------------------------------------ *
 * 上游：真实接口 或 录制回放
 * ------------------------------------------------------------------ */

async function* openAIChunks(messages, { withTools }) {
  if (MOCK) {
    yield* mockChunks(messages)
    return
  }

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      ...(withTools ? { tools: TOOLS } : {}),
    }),
  })

  if (!response.ok || !response.body) {
    throw new Error(`upstream ${response.status}: ${await response.text()}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
      if (!dataLine) continue
      const payload = dataLine.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        yield JSON.parse(payload)
      } catch {
        // 上游偶尔会发注释帧，忽略
      }
    }
  }
}

/** 没有 key 时的回放：形状与 OpenAI 完全一致，所以走的是同一套翻译逻辑。 */
async function* mockChunks(messages) {
  const isSecondRound = messages.some((message) => message.role === 'tool')
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  if (!isSecondRound) {
    for (const text of ['我先查一下', '有哪些相关项目。', '\n\n']) {
      await wait(60)
      yield { choices: [{ delta: { content: text } }] }
    }

    yield {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_demo_1',
                type: 'function',
                function: { name: 'search_projects', arguments: '{"query":' },
              },
            ],
          },
        },
      ],
    }
    await wait(120)
    yield {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"agent streaming ui"}' } }] } }],
    }
    await wait(80)
    yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    return
  }

  const answer = `## 找到 3 个相关项目

- **vercel/ai**（18.2k★）：React/Next.js 的流式 AI SDK，工具调用与生成式 UI 都在里面
- **assistant-ui**（9.4k★）：偏组件层的对话 UI，主打可组合的消息与工具渲染
- **copilotkit**（12.1k★）：把 Agent 状态同步到前端的方案，带 in-app agent 能力

\`\`\`ts
// 三者的共同点：都在解决"事件 → 界面"的映射，只是抽象层次不同
const ui = map(event)
\`\`\`

> 选型建议：状态机自己写，渲染层可以用现成的。`

  for (const piece of answer.match(/[\s\S]{1,18}/g) ?? []) {
    await wait(45)
    yield { choices: [{ delta: { content: piece } }] }
  }
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
}

/* ------------------------------------------------------------------ *
 * 工具执行（示例用，真实项目应该走 MCP / 内部服务）
 * ------------------------------------------------------------------ */

const PROJECTS = [
  { name: 'vercel/ai', stars: 18200, note: 'React/Next.js 流式 AI SDK' },
  { name: 'assistant-ui', stars: 9400, note: '可组合的对话 UI 组件' },
  { name: 'copilotkit', stars: 12100, note: 'Agent 状态同步到前端' },
  { name: 'langgraph', stars: 6100, note: '有状态 Agent 编排' },
  { name: 'mcp', stars: 4800, note: 'Model Context Protocol 规范' },
]

function runTool(name, rawArgs) {
  if (name !== 'search_projects') {
    return { ok: false, content: `unknown tool: ${name}` }
  }

  let args = {}
  try {
    args = JSON.parse(rawArgs || '{}')
  } catch {
    return { ok: false, content: '参数不是合法 JSON' }
  }

  const query = String(args.query ?? '')
  const topK = Number(args.topK ?? 3)
  const hits = PROJECTS.filter(
    (project) =>
      query === '' ||
      project.name.includes(query.toLowerCase()) ||
      project.note.includes(query) ||
      query.split(/\s+/).some((word) => project.note.toLowerCase().includes(word.toLowerCase())),
  ).slice(0, topK)

  const list = (hits.length > 0 ? hits : PROJECTS.slice(0, topK))
    .map((project) => `${project.name}（${(project.stars / 1000).toFixed(1)}k★）：${project.note}`)
    .join('\n')

  return { ok: true, content: list }
}

/* ------------------------------------------------------------------ *
 * 一轮对话（可能包含一次工具往返）
 * ------------------------------------------------------------------ */

async function streamCompletion(res, messages, { round }) {
  const translator = createOpenAIStreamTranslator()
  const callArgs = new Map()

  for await (const chunk of openAIChunks(messages, { withTools: round === 0 })) {
    for (const event of translator.translate(chunk)) {
      if (event.type === 'tool.args') {
        callArgs.set(event.callId, (callArgs.get(event.callId) ?? '') + event.arguments)
      }
      writeEvent(res, event)
    }
  }

  if (translator.finishReason !== 'tool_calls' || round > 0) {
    return
  }

  // 执行工具 → 回填结果 → 再跑一轮（真实的 Agent loop 就是这个形状）
  const calls = [...translator.toolCalls.values()]
  const assistantCalls = []

  for (const call of calls) {
    const raw = callArgs.get(call.callId) ?? '{}'
    const startedAt = Date.now()
    const result = runTool(call.name, raw)

    writeEvent(res, {
      type: 'tool.result',
      callId: call.callId,
      ok: result.ok,
      durationMs: Date.now() - startedAt,
      preview: result.content,
    })

    assistantCalls.push({
      id: call.callId,
      type: 'function',
      function: { name: call.name, arguments: raw },
    })

    messages.push({ role: 'tool', tool_call_id: call.callId, content: result.content })
  }

  messages.push({ role: 'assistant', content: null, tool_calls: assistantCalls })

  await streamCompletion(res, messages, { round: round + 1 })
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, last-event-id',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, mock: MOCK, model: MODEL }))
    return
  }

  if (url.pathname !== '/api/chat' || req.method !== 'POST') {
    res.writeHead(404, { ...cors, 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
    return
  }

  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    res.writeHead(400, { ...cors, 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid_json' }))
    return
  }

  const text = String(body.text ?? '').trim()
  const history = Array.isArray(body.history) ? body.history : []

  res.writeHead(200, {
    ...cors,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')

  seq = 0
  writeEvent(res, { type: 'turn.start', turnId: `turn_${Date.now().toString(36)}` })

  const messages = [
    {
      role: 'system',
      content: '你是一个简洁的技术助手。需要外部信息时先调用工具，不要编造。',
    },
    ...history
      .filter((item) => item && typeof item.text === 'string')
      .map((item) => ({ role: item.role === 'user' ? 'user' : 'assistant', content: item.text })),
    { role: 'user', content: text },
  ]

  try {
    await streamCompletion(res, messages, { round: 0 })
    writeEvent(res, { type: 'turn.end', reason: 'complete' })
  } catch (error) {
    writeEvent(res, {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      stage: 'generate',
      retriable: true,
    })
  } finally {
    res.end()
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[example] http://127.0.0.1:${PORT}  mode=${MOCK ? 'MOCK（无 key，回放录制 chunk）' : MODEL}`)
  console.log('[example] 前端启动：VITE_STREAM_URL=http://127.0.0.1:8788/api/chat npm run dev:web')
})
