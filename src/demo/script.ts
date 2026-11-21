import { formatSseFrame } from '../lib/sse/frame'
import type { ScriptedChunk } from '../lib/core/transport'

/**
 * 演示脚本：把一段"带工具调用的回答"切成 SSE 帧。
 *
 * 注意它走的是**和真实服务端完全一样**的路径：字符串 → 分帧器 → 事件 → reducer。
 * 所以即使没有后端，演示的也是真实现。
 */

interface RawFrame {
  event: string
  data: unknown
}

function frameText(id: number, event: string, data: unknown): string {
  return formatSseFrame({ id, event, data: JSON.stringify(data) })
}

/** 按句子切分，避免在词中间断开（视觉上更像模型输出）。 */
function splitForStreaming(text: string, size = 14): string[] {
  const chunks: string[] = []
  let cursor = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    const shouldCut =
      index - cursor >= size || '。！？；\n'.includes(char) || (char === ',' && index - cursor >= 8)
    if (shouldCut) {
      chunks.push(text.slice(cursor, index + 1))
      cursor = index + 1
    }
  }
  if (cursor < text.length) chunks.push(text.slice(cursor))
  return chunks.filter((chunk) => chunk !== '')
}

const OPENING = '我先把问题拆成两步：先查一下有哪些相关项目，再给结论。\n\n'

const ANSWER = `## 结论

流式 Agent 界面的难点不在"把字打出来"，而在**三个不确定性**：

1. **内容不确定**：文本是逐 token 到达的，Markdown 结构随时可能被改写；
2. **结构不确定**：工具调用的参数是边生成边到达的，JSON 可能长期处于残缺状态；
3. **连接不确定**：长连接会断，重连后必须从正确的位置继续。

处理办法是把这三件事分层：传输层只负责"可靠地拿到帧"，reducer 只负责"把帧折叠成状态"，组件只负责"画状态"。

\`\`\`ts
// 传输层：只做分帧 + 续传
const client = createSseClient({ url, method: 'POST', body, onEvent })
// 状态层：纯函数，可单测
const next = reduceAgentEvent(state, event)
\`\`\`

这样做的收益很直接：换 WebSocket 不动 reducer，换渲染不动传输，换模型不动后端。

> 一句话：**界面不应该知道 token 长什么样，它只应该认识事件。**

### 下一步

- 把"工具卡"抽成可注册的渲染器（Generative UI 的入口）
- 增加章节级重试，而不是整轮重跑
- 用真实模型替换脚本，验证首字延迟`

const TOOL_ARGS = '{"query":"agent streaming ui react","topK":5,"recency":"2026"}'

export interface DemoScript {
  chunks: ScriptedChunk[]
  toolName: string
}

export function buildDemoScript(): DemoScript {
  const frames: RawFrame[] = []

  frames.push({ event: 'turn.start', data: { turnId: 'demo-turn-1' } })

  for (const piece of splitForStreaming(OPENING)) {
    frames.push({ event: 'message.delta', data: { text: piece } })
  }

  frames.push({
    event: 'tool.call',
    data: { callId: 'call_1', name: 'search_projects', arguments: TOOL_ARGS },
  })

  frames.push({
    event: 'tool.result',
    data: {
      callId: 'call_1',
      ok: true,
      durationMs: 842,
      preview: '命中 3 个仓：vercel/ai（18.2k★）、assistant-ui（9.4k★）、copilotkit（12.1k★）',
    },
  })

  for (const piece of splitForStreaming(ANSWER)) {
    frames.push({ event: 'message.delta', data: { text: piece } })
  }

  frames.push({ event: 'turn.end', data: { reason: 'complete' } })

  const chunks: ScriptedChunk[] = frames.map((item, index) => {
    const isTool = item.event === 'tool.call'
    const isResult = item.event === 'tool.result'
    const isStart = item.event === 'turn.start'
    const isEnd = item.event === 'turn.end'

    let delayMs = 22
    if (isStart) delayMs = 140
    if (isTool) delayMs = 320
    if (isResult) delayMs = 620
    if (isEnd) delayMs = 160

    return { delayMs, chunk: frameText(index + 1, item.event, item.data) }
  })

  return { chunks, toolName: 'search_projects' }
}

/** 失败演示：工具报错 + 回合中止，用来验证错误态与重试入口。 */
export function buildFailureScript(): DemoScript {
  const frames: RawFrame[] = [
    { event: 'turn.start', data: { turnId: 'demo-turn-fail' } },
  ]

  for (const piece of splitForStreaming('我来查一下这个仓的 issue。\n\n')) {
    frames.push({ event: 'message.delta', data: { text: piece } })
  }

  frames.push({
    event: 'tool.call',
    data: { callId: 'call_fail', name: 'github_issues', arguments: '{"repo":"vercel/ai","state":"open"' },
  })

  frames.push({
    event: 'tool.result',
    data: { callId: 'call_fail', ok: false, durationMs: 1210, preview: 'upstream 502 Bad Gateway' },
  })

  frames.push({
    event: 'error',
    data: { message: '工具返回 502，已重试 2 次', stage: 'retrieve', retriable: true },
  })

  const chunks: ScriptedChunk[] = frames.map((item, index) => ({
    delayMs: item.event === 'tool.result' ? 700 : 30,
    chunk: frameText(index + 1, item.event, item.data),
  }))

  return { chunks, toolName: 'github_issues' }
}
