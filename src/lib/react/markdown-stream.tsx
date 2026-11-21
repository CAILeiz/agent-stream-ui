import { memo, useMemo } from 'react'
import { splitBlocks } from '../markdown/blocks'
import { MarkdownBlockView } from '../markdown/render'

export interface MarkdownStreamProps {
  text: string
  /** 是否还在流式追加：只有尾块会重新解析，并显示光标。 */
  streaming?: boolean
  className?: string
}

/**
 * 流式 Markdown。
 *
 * 成本模型：每次文本变化 O(n) 切块（纯字符串扫描，无正则回溯），
 * 解析成本只落在未闭合的尾块上；已闭合块命中缓存后只做一次元素复用。
 */
export const MarkdownStream = memo(function MarkdownStream({
  text,
  streaming = false,
  className,
}: MarkdownStreamProps) {
  const blocks = useMemo(() => splitBlocks(text), [text])

  return (
    <div className={className ? `asui-md ${className}` : 'asui-md'}>
      {blocks.map((block) => (
        <MarkdownBlockView
          key={block.key}
          block={block}
          streaming={streaming && !block.closed}
        />
      ))}
      {streaming && <span className="asui-caret" aria-hidden="true" />}
    </div>
  )
})
