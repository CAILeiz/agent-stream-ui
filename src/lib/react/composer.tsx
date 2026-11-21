import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { RetryIcon, SendIcon, SparkIcon, StopIcon } from './icons'

export interface ComposerProps {
  running: boolean
  canRetry: boolean
  placeholder?: string
  disabled?: boolean
  onSend: (text: string) => void
  onStop: () => void
  onRetry: () => void
}

const MAX_HEIGHT_PX = 200

export function Composer({
  running,
  canRetry,
  placeholder = '发消息…',
  disabled = false,
  onSend,
  onStop,
  onRetry,
}: ComposerProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // 自适应高度：先归零再读 scrollHeight，否则文本删短时不会回缩
  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [value])

  const submit = () => {
    const text = value.trim()
    if (text === '' || running || disabled) return
    setValue('')
    onSend(text)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="asui-composer">
      <div className="asui-composer-box">
        <SparkIcon className="asui-composer-spark" />
        <textarea
          ref={textareaRef}
          className="asui-composer-input"
          value={value}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="输入消息"
        />

        {running ? (
          <button
            type="button"
            className="asui-btn asui-btn--stop"
            onClick={onStop}
            title="停止生成"
            aria-label="停止生成"
          >
            <StopIcon />
          </button>
        ) : canRetry ? (
          <button
            type="button"
            className="asui-btn asui-btn--retry"
            onClick={onRetry}
            title="重试"
            aria-label="重试"
          >
            <RetryIcon />
          </button>
        ) : (
          <button
            type="button"
            className="asui-btn asui-btn--send"
            onClick={submit}
            disabled={value.trim() === '' || disabled}
            title="发送"
            aria-label="发送"
          >
            <SendIcon />
          </button>
        )}
      </div>

      <p className="asui-composer-hint">
        <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行
      </p>
    </div>
  )
}
