import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSummary, digestBullets, fallbackMindmap } from '../lib/summarize.js'

const good = `# 课程

## 核心知识点
- **监督学习**
  - 要点一
- **过拟合**
  - 要点二

## 思维导图
\`\`\`mermaid
mindmap
  root((课程))
    监督学习
\`\`\`

## 复习清单
- [ ] 自测
`

test('normalizeSummary keeps a complete summary', () => {
  const out = normalizeSummary(good, { title: '课程', keywords: ['监督学习'] })
  assert.match(out, /^# 课程/)
  assert.match(out, /## 核心知识点/)
  assert.match(out, /mindmap/)
})

test('normalizeSummary adds missing mindmap and sections', () => {
  const out = normalizeSummary('# 课程\n\n## 核心知识点\n- 要点', { title: '课程', keywords: ['A'] })
  assert.match(out, /## 思维导图/)
  assert.match(out, /## 复习清单/)
  assert.match(out, /## 内容来源与覆盖度/)
})

test('fallbackMindmap escapes parentheses', () => {
  const mm = fallbackMindmap('标题(测试)', ['A(B)'])
  assert.match(mm, /mindmap/)
  assert.doesNotMatch(mm, /\(B\)/)
})

test('digestBullets pulls knowledge bullets', () => {
  const bullets = digestBullets(good)
  assert.ok(bullets.length >= 2)
  assert.ok(bullets[0].includes('监督学习') || bullets[0].includes('要点'))
})
