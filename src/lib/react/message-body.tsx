import type { Message, MessagePart, ToolCallState } from '../types'
import { MarkdownStream } from './markdown-stream'
import { ToolCallCard } from './tool-call-card'
import { AlertIcon } from './icons'

export interface MessageBodyProps {
  parts: MessagePart[]
  toolCalls: ToolCallState[]
  streaming: boolean
  role: Message['role']
}

/** 按到达顺序渲染「文本 / 工具卡」，而不是把工具卡统一堆到末尾。 */
export function MessageBody({ parts, toolCalls, streaming, role }: MessageBodyProps) {
  const byId = new Map(toolCalls.map((tool) => [tool.callId, tool]))

  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'text' ? (
          <MarkdownStream
            key={`text-${index}`}
            text={part.text}
            streaming={streaming && index === parts.length - 1}
          />
        ) : (
          <ToolCallCard key={`tool-${part.callId}`} tool={byId.get(part.callId) ?? missingTool(part.callId)} />
        ),
      )}
      {role === 'assistant' && streaming && parts.length === 0 && (
        <div className="asui-typing" data-testid="typing-indicator" aria-label="正在生成">
          <span />
          <span />
          <span />
        </div>
      )}
    </>
  )
}

function missingTool(callId: string): ToolCallState {
  return {
    callId,
    name: 'unknown_tool',
    args: '',
    argsComplete: true,
    status: 'error',
    preview: '工具调用状态缺失',
    startedAt: 0,
  }
}

export function ErrorNote({ message, stage }: { message: string; stage: string }) {
  return (
    <div className="asui-error" role="alert">
      <AlertIcon />
      <div>
        <strong>本轮失败</strong>
        <p>
          {message}
          {stage !== 'unknown' ? `（阶段：${stage}）` : ''}
        </p>
      </div>
    </div>
  )
}
