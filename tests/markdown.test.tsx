import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { isSafeHref, parseInline } from '../src/lib/markdown/inline'
import { MarkdownStream } from '../src/lib/react/markdown-stream'

function html(text: string): string {
  return renderToStaticMarkup(<MarkdownStream text={text} streaming />)
}

describe('parseInline', () => {
  it('渲染行内代码 / 粗体 / 斜体', () => {
    const out = html('用 `npm i` 然后 **注意** 与 *强调*')
    expect(out).toContain('<code class="asui-inline-code">npm i</code>')
    expect(out).toContain('<strong>注意</strong>')
    expect(out).toContain('<em>强调</em>')
  })

  it('链接带 noopener 并且新窗口打开', () => {
    const out = html('见 [文档](https://example.com/a)')
    expect(out).toContain('href="https://example.com/a"')
    expect(out).toContain('rel="noreferrer noopener"')
    expect(out).toContain('target="_blank"')
  })

  it('javascript: 协议被拒，输出纯文本', () => {
    const out = html('[点我](javascript:alert(1))')
    expect(out).not.toContain('href')
    expect(out).toContain('点我')
  })

  it('不会把用户文本当 HTML 执行', () => {
    const out = html('<img src=x onerror="alert(1)">')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
  })

  it('裸 URL 自动成链', () => {
    const out = html('参考 https://example.com/x 这里')
    expect(out).toContain('href="https://example.com/x"')
  })
})

describe('isSafeHref', () => {
  it.each([
    ['https://a.com', true],
    ['http://a.com', true],
    ['mailto:a@b.com', true],
    ['/relative', true],
    ['#anchor', true],
    ['javascript:alert(1)', false],
    ['data:text/html,x', false],
    ['', false],
  ])('%s -> %s', (href, expected) => {
    expect(isSafeHref(href)).toBe(expected)
  })
})

describe('MarkdownStream', () => {
  it('标题按级别输出对应标签', () => {
    const out = html('## 二级')
    expect(out).toContain('<h2 class="asui-h asui-h2">二级</h2>')
  })

  it('列表输出 ol/ul', () => {
    expect(html('1. 一\n2. 二')).toContain('<ol class="asui-list">')
    expect(html('- 一\n- 二')).toContain('<ul class="asui-list">')
  })

  it('流式未完成时显示光标，完成后不显示', () => {
    expect(html('正在写')).toContain('asui-caret')
    const done = renderToStaticMarkup(<MarkdownStream text="写完了" streaming={false} />)
    expect(done).not.toContain('asui-caret')
  })

  it('代码块带语言标签', () => {
    const out = html('```ts\nconst a = 1\n```')
    expect(out).toContain('asui-code-lang')
    expect(out).toContain('>ts<')
  })

  it('相邻文本节点保持在同一段落内', () => {
    const out = parseInline('前半后半')
    expect(out).toEqual(['前半后半'])
  })
})
