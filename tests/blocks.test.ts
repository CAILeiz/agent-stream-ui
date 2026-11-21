import { describe, expect, it } from 'vitest'
import { listItemText, splitBlocks, languageLabel } from '../src/lib/markdown/blocks'

describe('splitBlocks', () => {
  it('标题独立成块并带级别', () => {
    const blocks = splitBlocks('# 标题\n正文')
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: '标题', closed: true })
    expect(blocks[1]).toMatchObject({ kind: 'paragraph', text: '正文', closed: false })
  })

  it('空行结束段落', () => {
    const blocks = splitBlocks('第一段\n\n第二段\n')
    expect(blocks.map((block) => [block.kind, block.closed])).toEqual([
      ['paragraph', true],
      ['paragraph', true],
    ])
  })

  it('围栏代码整体成块，内部不做解析', () => {
    const blocks = splitBlocks('前\n\n```ts\nconst a = 1\n# 不是标题\n```\n\n后\n')
    const code = blocks.find((block) => block.kind === 'code')
    expect(code?.text).toBe('const a = 1\n# 不是标题')
    expect(code?.lang).toBe('ts')
    expect(code?.closed).toBe(true)
  })

  it('未闭合的代码块标记为 open（流式中间态）', () => {
    const blocks = splitBlocks('```ts\nconst a = ')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'code', closed: false, lang: 'ts' })
  })

  it('列表按有序/无序分组', () => {
    const blocks = splitBlocks('- 一\n- 二\n\n1. 甲\n2. 乙')
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false })
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: true })
  })

  it('引用与分割线', () => {
    const blocks = splitBlocks('> 引用一行\n> 第二行\n\n---')
    expect(blocks[0]).toMatchObject({ kind: 'quote', text: '引用一行\n第二行' })
    expect(blocks[1]).toMatchObject({ kind: 'hr' })
  })

  it('key 稳定：追加内容不改变前序块的 key', () => {
    const before = splitBlocks('# a\n\npara')
    const after = splitBlocks('# a\n\npara more')
    expect(after[0]?.key).toBe(before[0]?.key)
    expect(after[1]?.key).toBe(before[1]?.key)
  })

  it('空文本返回空数组', () => {
    expect(splitBlocks('')).toHaveLength(0)
  })
})

describe('listItemText', () => {
  it('去掉无序与有序 marker', () => {
    expect(listItemText('- 项目')).toBe('项目')
    expect(listItemText('  1. 第一步')).toBe('第一步')
  })
})

describe('languageLabel', () => {
  it('常见别名归一', () => {
    expect(languageLabel('typescript')).toBe('ts')
    expect(languageLabel('PY')).toBe('py')
    expect(languageLabel(undefined)).toBe('text')
    expect(languageLabel('rust')).toBe('rust')
  })
})
