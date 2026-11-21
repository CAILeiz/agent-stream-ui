/**
 * Markdown 分块：把流式文本切成「已经定型的块」和「还在长的尾块」。
 *
 * 这是流式渲染性能的关键：每来一个 token 都全量 parse 整段 markdown，
 * 长回答下会明显掉帧。按块切开以后，已闭合的块可以命中缓存，只有尾块
 * 需要重新解析——通常它只有一两行。
 *
 * 只支持对话场景够用的子集：标题、段落、围栏代码、列表、引用、分割线。
 * 表格和 HTML 明确不支持（见 docs/design-notes.md）。
 */

export type BlockKind = 'heading' | 'paragraph' | 'code' | 'list' | 'quote' | 'hr'

export interface MdBlock {
  /** 位置 + 类型，保证流式追加时 key 稳定。 */
  key: string
  kind: BlockKind
  text: string
  /** true = 后面已经出现别的块或空行，内容不会再变，可以缓存。 */
  closed: boolean
  /** 标题级别 1–6。 */
  level?: number
  /** 代码块语言。 */
  lang?: string
  /** 列表是否有序。 */
  ordered?: boolean
}

const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^(```|~~~)\s*([\w+#.-]*)\s*$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const QUOTE = /^\s*>\s?/
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/

interface Pending {
  kind: Exclude<BlockKind, 'hr'>
  lines: string[]
  level?: number
  lang?: string
  ordered?: boolean
}

function flush(blocks: MdBlock[], pending: Pending | null, closed: boolean) {
  if (!pending || pending.lines.length === 0) return
  const text = pending.lines.join('\n')
  blocks.push({
    key: `${pending.kind}-${blocks.length}`,
    kind: pending.kind,
    text,
    closed,
    ...(pending.level === undefined ? {} : { level: pending.level }),
    ...(pending.lang === undefined ? {} : { lang: pending.lang }),
    ...(pending.ordered === undefined ? {} : { ordered: pending.ordered }),
  })
  pending.lines = []
}

export function splitBlocks(text: string): MdBlock[] {
  const lines = text.split('\n')
  const blocks: MdBlock[] = []
  let pending: Pending | null = null

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const fenceMatch = FENCE.exec(line.trim())

    // 围栏代码：整体吞掉，内部不再做任何解析
    if (fenceMatch) {
      flush(blocks, pending, true)
      pending = null

      const marker = fenceMatch[1] ?? '```'
      const lang = fenceMatch[2] ?? ''
      const body: string[] = []
      let closed = false
      index += 1

      for (; index < lines.length; index += 1) {
        const inner = lines[index] ?? ''
        if (inner.trim().startsWith(marker)) {
          closed = true
          index += 1
          break
        }
        body.push(inner)
      }

      blocks.push({
        key: `code-${blocks.length}`,
        kind: 'code',
        text: body.join('\n'),
        closed,
        lang,
      })
      continue
    }

    // 空行：结束当前块
    if (line.trim() === '') {
      flush(blocks, pending, true)
      pending = null
      index += 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush(blocks, pending, true)
      pending = null
      blocks.push({
        key: `heading-${blocks.length}`,
        kind: 'heading',
        text: heading[2] ?? '',
        closed: true,
        level: (heading[1] ?? '#').length,
      })
      index += 1
      continue
    }

    if (HR.test(line)) {
      flush(blocks, pending, true)
      pending = null
      blocks.push({
        key: `hr-${blocks.length}`,
        kind: 'hr',
        text: '',
        closed: true,
      })
      index += 1
      continue
    }

    if (QUOTE.test(line)) {
      if (pending && pending.kind !== 'quote') {
        flush(blocks, pending, true)
        pending = null
      }
      pending ??= { kind: 'quote', lines: [] }
      pending.lines.push(line.replace(QUOTE, ''))
      index += 1
      continue
    }

    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      if (pending && pending.kind !== 'list') {
        flush(blocks, pending, true)
        pending = null
      }
      if (pending && pending.ordered !== ordered) {
        flush(blocks, pending, true)
        pending = null
      }
      pending ??= { kind: 'list', lines: [], ordered }
      pending.lines.push(line)
      index += 1
      continue
    }

    // 普通段落
    if (pending && pending.kind !== 'paragraph') {
      flush(blocks, pending, true)
      pending = null
    }
    pending ??= { kind: 'paragraph', lines: [] }
    pending.lines.push(line)
    index += 1
  }

  // 末尾还在长的块：不闭合，交给尾块渲染（不进缓存）
  flush(blocks, pending, false)

  return blocks
}

/** 列表项文本：去掉 marker / 缩进。 */
export function listItemText(line: string): string {
  return line.replace(LIST_ITEM, '')
}

/** 复制按钮展示用：把语言名规整成人能看的标签。 */
export function languageLabel(lang: string | undefined): string {
  if (!lang) return 'text'
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    typescript: 'ts',
    js: 'js',
    javascript: 'js',
    json: 'json',
    bash: 'bash',
    sh: 'sh',
    python: 'py',
    py: 'py',
    css: 'css',
    html: 'html',
  }
  return map[lang.toLowerCase()] ?? lang
}
