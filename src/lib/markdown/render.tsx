/**
 * 块 → React 节点。
 *
 * 已闭合的块按「类型 + 内容」缓存渲染结果。缓存的是一棵不可变元素树，
 * 复用它不会跳过子组件的状态（React 只按元素类型和 key 协调），
 * 但省掉了重复解析和重复创建元素的成本。
 */

import { memo, useState, type ReactNode } from 'react'
import { languageLabel, listItemText, type MdBlock } from './blocks'
import { parseInline, parseInlineLines } from './inline'

const CACHE_LIMIT = 500
const blockCache = new Map<string, ReactNode>()

function cacheKey(block: MdBlock): string {
  return [block.kind, block.level ?? '', block.lang ?? '', block.ordered ? '1' : '0', block.text].join(
    '\u0000',
  )
}

export function renderBlock(block: MdBlock, streaming: boolean): ReactNode {
  const key = cacheKey(block)

  if (block.closed) {
    const cached = blockCache.get(key)
    if (cached !== undefined) return cached
  }

  const node = renderUncached(block, streaming)

  if (block.closed) {
    if (blockCache.size >= CACHE_LIMIT) {
      const oldest = blockCache.keys().next()
      if (!oldest.done) blockCache.delete(oldest.value)
    }
    blockCache.set(key, node)
  }

  return node
}

/** 测试用：确认缓存命中行为。 */
export function clearBlockCache(): void {
  blockCache.clear()
}

function renderUncached(block: MdBlock, streaming: boolean): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(Math.max(block.level ?? 1, 1), 6)
      const Tag = `h${level}` as 'h1'
      return (
        <Tag className={`asui-h asui-h${level}`}>{parseInline(block.text)}</Tag>
      )
    }

    case 'code':
      return <CodeBlock code={block.text} lang={block.lang} streaming={streaming} />

    case 'list': {
      const items = block.text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => listItemText(line))

      const children = items.map((item, index) => (
        <li key={`li-${index}`}>{parseInline(item)}</li>
      ))

      return block.ordered ? (
        <ol className="asui-list">{children}</ol>
      ) : (
        <ul className="asui-list">{children}</ul>
      )
    }

    case 'quote':
      return <blockquote className="asui-quote">{parseInlineLines(block.text)}</blockquote>

    case 'hr':
      return <hr className="asui-hr" />

    case 'paragraph':
    default:
      return <p className="asui-p">{parseInlineLines(block.text)}</p>
  }
}

function CodeBlock({
  code,
  lang,
  streaming,
}: {
  code: string
  lang?: string
  streaming: boolean
}) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!clipboard) return
    void clipboard.writeText(code).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      },
      () => {},
    )
  }

  return (
    <div className="asui-code">
      <div className="asui-code-head">
        <span className="asui-code-lang">{languageLabel(lang)}</span>
        {!streaming && (
          <button type="button" className="asui-code-copy" onClick={copy}>
            {copied ? '已复制' : '复制'}
          </button>
        )}
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

/** 单块渲染，供 MarkdownStream 做浅比较跳过未变化的块。 */
export const MarkdownBlockView = memo(
  function MarkdownBlockView({
    block,
    streaming,
  }: {
    block: MdBlock
    streaming: boolean
  }) {
    return <>{renderBlock(block, streaming)}</>
  },
  (prev, next) =>
    prev.streaming === next.streaming &&
    prev.block.kind === next.block.kind &&
    prev.block.closed === next.block.closed &&
    prev.block.level === next.block.level &&
    prev.block.lang === next.block.lang &&
    prev.block.ordered === next.block.ordered &&
    prev.block.text === next.block.text,
)
