/**
 * 增量渲染基准：常见做法（markdown-it 全量解析）vs 本库（分块 + 只重解析尾块）。
 *
 * 用法：`npm run bench`（会先构建 dist）
 *
 * 只测「切块 / 解析 / 创建元素」。React 的 reconciliation 与 DOM 提交两者相同，
 * 这里比较的正是被省掉的那一段。markdown-it 未开启 HTML 与插件，已经是对它最友好的配置。
 */

import MarkdownIt from 'markdown-it'
import { clearBlockCache, renderBlock, splitBlocks } from '../dist/agent-stream-ui.js'

const md = new MarkdownIt({ html: false, linkify: true })

const SECTION = `## 分层

流式界面的难点不在把字打出来，而在三个不确定性：

- **内容**：文本逐 token 到达，Markdown 结构随时可能被改写
- **结构**：工具参数边生成边到达，JSON 可能长期残缺
- **连接**：长连接会断，重连必须从正确位置继续

处理办法是把这三件事分层：传输层只负责可靠地拿到帧，reducer 只负责把帧折叠成状态，组件只负责画状态。

\`\`\`ts
const next = reduceAgentEvent(state, event)
\`\`\`

> 界面不应该知道 token 长什么样，它只应该认识事件。
`

const SECTIONS = 40
const SAMPLE = Array.from({ length: SECTIONS }, (_, index) => `${SECTION}\n<!-- ${index} -->\n`).join('\n')
const CHUNK = 20

const frames = []
for (let cursor = 0; cursor < SAMPLE.length; cursor += CHUNK) {
  frames.push(SAMPLE.slice(0, cursor + CHUNK))
}

function time(fn) {
  fn(frames.slice(0, 10)) // 预热
  const started = performance.now()
  fn(frames)
  return performance.now() - started
}

/** 基线 1：每帧把全文交给 markdown-it（大量项目的默认实现） */
const markdownIt = time((list) => {
  for (const text of list) md.render(text)
})

/** 基线 2：本库的分块解析，但每帧清空缓存（等于没做增量） */
const fullParse = time((list) => {
  for (const text of list) {
    clearBlockCache()
    for (const block of splitBlocks(text)) renderBlock(block, false)
  }
})

/** 本库：只重新渲染内容变化的块 */
const incremental = time((list) => {
  const previous = []
  for (const text of list) {
    const blocks = splitBlocks(text)
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      const prior = previous[index]
      const changed =
        prior === undefined || prior.text !== block.text || prior.closed !== block.closed
      if (changed) renderBlock(block, !block.closed)
      previous[index] = { text: block.text, closed: block.closed }
    }
    previous.length = blocks.length
  }
})

const perFrame = (elapsed) => elapsed / frames.length
const blocks = splitBlocks(SAMPLE).length

console.log(
  `样本 ${SAMPLE.length.toLocaleString()} 字符 · ${blocks} 块 · ${frames.length} 帧（每帧追加 ${CHUNK} 字符）`,
)
console.log('')
console.log('| 策略 | 总耗时 | 每帧 | 60fps 预算占比 |')
console.log('| --- | ---: | ---: | ---: |')
for (const [label, elapsed] of [
  ['markdown-it 全量解析', markdownIt],
  ['本库分块（关闭缓存）', fullParse],
  ['本库增量（只重解析尾块）', incremental],
]) {
  const frame = perFrame(elapsed)
  console.log(
    `| ${label} | ${elapsed.toFixed(0)} ms | ${frame.toFixed(3)} ms | ${((frame / 16.7) * 100).toFixed(1)}% |`,
  )
}
console.log('')
console.log(`相对 markdown-it 全量：${(markdownIt / incremental).toFixed(0)}×`)
console.log(`相对分块但关闭缓存：${(fullParse / incremental).toFixed(0)}×`)
