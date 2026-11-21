# 接一个真实的 OpenAI 兼容模型

这个示例把 `agent-stream-ui` 接到任何 OpenAI 兼容的 `/chat/completions` 流上（OpenAI、DeepSeek、通义、vLLM、Ollama……），中间只多一层**事件翻译**。

```bash
npm run build:lib            # 示例直接用 dist 产物，顺便验证发布物可用

# 有 key：走真实模型
OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-mini node examples/openai-compatible/server.mjs

# 没 key：MOCK 模式，用同一套翻译逻辑回放录制好的 chunk
node examples/openai-compatible/server.mjs

# 另开一个终端，把前端指过来
VITE_STREAM_URL=http://127.0.0.1:8788/api/chat npm run dev:web
```

打开 <http://localhost:5173>，右上角应该显示「真实 SSE」。

## 翻译规则

适配器在库里（`createOpenAIStreamTranslator`），不在示例里——因为这段代码每个人都要写一遍，而且细节最容易写错。

| OpenAI chunk | 本库事件 | 注意 |
| --- | --- | --- |
| `delta.content` | `message.delta` | 空串要丢掉，否则会触发无意义渲染 |
| `delta.tool_calls[i].id` 首次出现 | `tool.call` | `id` 只在第一片出现 |
| `delta.tool_calls[i].function.arguments` | `tool.args` | **按 `index` 关联**，不是按 id |
| `finish_reason: 'tool_calls'` | `tool.args { complete: true }` | 显式收口，UI 才能把"生成中"换掉 |
| `finish_reason: 'stop'` | `turn.end { reason: 'complete' }` | 服务端负责发 |

三个坑，示例里都处理了：

1. **工具参数是分片的**。`arguments` 会以 `{"query":` / `"杭州"}` 这种碎片到达，拼起来才是 JSON。所以协议里单独有 `tool.args` 增量事件，而不是让 `tool.call` 重复发（重复发会被去重掉，参数就丢了）。
2. **`id` 只在第一片出现**。后续分片只能靠 `index` 关联；有的服务端连 `index` 都不给，那就退化成单工具。
3. **一轮结束后还有一轮**。`finish_reason: tool_calls` 不是"回答完了"，是"该执行工具了"。示例里执行完工具会带着结果再请求一次，这才是完整的 Agent loop。

## 这个示例不做什么

- **不做断点续传**。示例是无状态的，断了就从头来。要看续传，用仓库里的 `server/mock-agent.mjs`——它演示了 `Last-Event-ID` + outbox 游标。
- **不做多轮工具编排**。只允许一轮工具往返（`round > 0` 时不再给 tools），真实项目要加上轮次上限和预算。
- **不接 MCP**。工具是本地函数，生产环境应该接到 MCP server 或内部工具网关。
