/**
 * 行内解析：只认 `code`、**bold**、*italic*、[link](url)、裸 URL。
 *
 * 关键取舍：**不用 dangerouslySetInnerHTML**。
 * 模型输出是不可信文本，一旦走 innerHTML 就等于把 XSS 交给模型的心情。
 * 这里全部构造 React 节点，天然转义；链接还要过协议白名单。
 */

import { Fragment, type ReactNode } from 'react'

const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>"']+)/g

export function isSafeHref(href: string): boolean {
  const trimmed = href.trim()
  if (trimmed === '') return false
  if (trimmed.startsWith('#')) return true
  if (trimmed.startsWith('/')) return true
  return /^(https?:|mailto:)/i.test(trimmed)
}

function renderLink(label: string, href: string, key: string): ReactNode {
  if (!isSafeHref(href)) return <Fragment key={key}>{label}</Fragment>
  return (
    <a key={key} href={href} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  )
}

export function parseInline(text: string): ReactNode[] {
  if (text === '') return []

  const nodes: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  INLINE_PATTERN.lastIndex = 0
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index))
    }

    const token = match[0]
    const key = `i-${nodes.length}`

    if (token.startsWith('`')) {
      nodes.push(
        <code className="asui-inline-code" key={key}>
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (linkMatch) {
        nodes.push(renderLink(linkMatch[1] ?? '', linkMatch[2] ?? '', key))
      } else {
        nodes.push(token)
      }
    } else {
      nodes.push(renderLink(token, token, key))
    }

    cursor = match.index + token.length
  }

  if (cursor < text.length) nodes.push(text.slice(cursor))

  return nodes
}

/** 段落里的硬换行：单换行 → `<br />`。 */
export function parseInlineLines(text: string): ReactNode[] {
  const lines = text.split('\n')
  const nodes: ReactNode[] = []

  lines.forEach((line, index) => {
    if (index > 0) nodes.push(<br key={`br-${index}`} />)
    nodes.push(...parseInline(line))
  })

  return nodes
}
