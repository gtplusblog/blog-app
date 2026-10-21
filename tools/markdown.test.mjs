/**
 * Markdown → HTML 渲染测试（纯函数，无需浏览器）。
 * 重点覆盖与线上 Hugo 主题一致的数学公式处理：
 * 公式里的 `_`、`*`、`\\` 不能被 Markdown 强调语法吃掉。
 *
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderMarkdown } from '../.test-build/lib/markdown.js'

test('基础 Markdown：标题、粗体、列表、表格、代码块', () => {
  const src = [
    '## 标题',
    '',
    '这是 **粗体** 和 *斜体*。',
    '',
    '- 一',
    '- 二',
    '',
    '| 列 1 | 列 2 |',
    '| --- | --- |',
    '| a | b |',
    '',
    '```js',
    'const a = 1',
    '```',
  ].join('\n')
  const { html } = renderMarkdown(src, false)
  assert.match(html, /<h2[^>]*>标题<\/h2>/)
  assert.match(html, /<strong>粗体<\/strong>/)
  assert.match(html, /<em>斜体<\/em>/)
  assert.match(html, /<ul>/)
  assert.match(html, /<table>/)
  assert.match(html, /<pre><code/)
})

test('math=false 时不渲染公式（与 front matter 联动）', () => {
  const { html } = renderMarkdown('行内 $a_1 + b_2$ 公式', false)
  assert.ok(!html.includes('katex'), '未开启 math 时不应出现 KaTeX 结构')
})

test('行内公式：$...$ 里的下划线不被当成强调语法', () => {
  const { html } = renderMarkdown('设 $a_1 = b_2$ 成立。', true)
  assert.match(html, /class="math-inline"/)
  assert.match(html, /katex/)
  assert.ok(!html.includes('<em>'), '公式中的下划线不应生成 <em>')
  // 下标被真正渲染出来（KaTeX 用 .msupsub 表示下标；只有 \text{} 之类才会带原始 TeX）
  assert.match(html, /msupsub/, `公式应渲染出下标，实际：${html.slice(0, 200)}`)
})

test('块级公式：$$...$$ 渲染为独立块', () => {
  const { html } = renderMarkdown('前文\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\n后文', true)
  assert.match(html, /class="math-block"/)
  assert.ok(!html.includes('<p><div class="math-block">'), '块级公式不应被包在 <p> 里')
  assert.ok(html.includes('前文') && html.includes('后文'))
})

test('块级公式：\\[...\\] 定界符（hugo.toml 的 passthrough 配置）', () => {
  const { html } = renderMarkdown('\\[ E = mc^2 \\]', true)
  assert.match(html, /class="math-block"/)
})

test('行内公式：\\(...\\) 定界符', () => {
  const { html } = renderMarkdown('能量 \\(E = mc^2\\) 成立', true)
  assert.match(html, /class="math-inline"/)
})

test('公式写错时给出可见错误而不是整页崩掉', () => {
  const { html } = renderMarkdown('$\\frac{1}{$', true)
  assert.ok(html.includes('math-error') || html.includes('katex'), '错误公式应降级显示')
  assert.ok(html.length > 0)
})

test('多个公式共存时占位符不会串位', () => {
  const { html } = renderMarkdown('$a$ 与 $b$ 与 $$c$$ 混排', true)
  const inlineCount = (html.match(/class="math-inline"/g) ?? []).length
  assert.equal(inlineCount, 2)
  assert.match(html, /class="math-block"/)
})

test('HTML 标签按 Hugo(goldmark unsafe=true) 的行为透传', () => {
  const { html } = renderMarkdown('<div class="x">原文</div>', true)
  assert.ok(html.includes('class="x"'))
})

test('外链自动加 target 与 rel', () => {
  const { html } = renderMarkdown('[链接](https://example.com)', false)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
})

test('图片带懒加载属性', () => {
  const { html } = renderMarkdown('![图](https://gtplusblog.github.io/images/a.jpg)', false)
  assert.match(html, /loading="lazy"/)
})

test('<!--more--> 摘要分隔符被保留为注释', () => {
  const { html } = renderMarkdown('摘要\n\n<!--more-->\n\n正文', false)
  assert.ok(html.includes('<!--more-->'))
})

test('任务列表渲染为复选框', () => {
  const { html } = renderMarkdown('- [ ] 未完成\n- [x] 已完成', false)
  assert.match(html, /type="checkbox"/)
})
