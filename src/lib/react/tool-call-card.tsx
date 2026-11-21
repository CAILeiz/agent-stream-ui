import { useState } from 'react'
import type { ToolCallState } from '../types'
import { repairPartialJson } from '../core/reducer'
import { CheckIcon, AlertIcon, ToolIcon } from './icons'

export interface ToolCallCardProps {
  tool: ToolCallState
}

const MAX_VALUE_CHARS = 160

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value)
  }
  try {
    const text = JSON.stringify(value)
    return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text
  } catch {
    return '[unserializable]'
  }
}

function statusLabel(tool: ToolCallState): string {
  if (tool.status === 'running') return '调用中'
  if (tool.status === 'ok') return '完成'
  return '失败'
}

function durationLabel(tool: ToolCallState): string | null {
  if (tool.durationMs === undefined) return null
  if (tool.durationMs < 1000) return `${Math.max(1, Math.round(tool.durationMs))}ms`
  return `${(tool.durationMs / 1000).toFixed(1)}s`
}

/**
 * 工具调用卡。
 *
 * 三态：入参还在流式生成（可能是不完整 JSON）、成功、失败。
 * 入参不完整时**不做激进补全**——把原文摆出来，比给用户看一个猜出来的
 * 半截参数诚实得多。
 */
export function ToolCallCard({ tool }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(tool.status === 'error')

  const parsed = tool.args.trim() === '' ? null : repairPartialJson(tool.args)
  const rows =
    parsed && typeof parsed.value === 'object' && parsed.value !== null
      ? Object.entries(parsed.value as Record<string, unknown>)
      : null

  const duration = durationLabel(tool)

  return (
    <section
      className={`asui-tool asui-tool--${tool.status}`}
      data-testid="tool-call-card"
      data-status={tool.status}
    >
      <button
        type="button"
        className="asui-tool-head"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="asui-tool-icon">
          {tool.status === 'ok' ? (
            <CheckIcon />
          ) : tool.status === 'error' ? (
            <AlertIcon />
          ) : (
            <ToolIcon />
          )}
        </span>
        <span className="asui-tool-name">{tool.name}</span>
        <span className="asui-tool-status">{statusLabel(tool)}</span>
        {duration && <span className="asui-tool-duration">{duration}</span>}
        <span className={`asui-tool-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true">
          ›
        </span>
      </button>

      {expanded && (
        <div className="asui-tool-body">
          {rows && rows.length > 0 ? (
            <dl className="asui-tool-args">
              {rows.map(([key, value]) => (
                <div className="asui-tool-arg" key={key}>
                  <dt>{key}</dt>
                  <dd>{formatValue(value)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <pre className="asui-tool-raw">{tool.args || '（无参数）'}</pre>
          )}

          {!tool.argsComplete && tool.status === 'running' && (
            <p className="asui-tool-hint">
              参数生成中…
              {parsed && !parsed.complete ? '（当前为不完整 JSON，已按可解析部分展示）' : ''}
            </p>
          )}

          {tool.preview && (
            <pre className="asui-tool-preview" data-testid="tool-preview">
              {tool.preview}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}
