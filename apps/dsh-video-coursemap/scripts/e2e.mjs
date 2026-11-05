#!/usr/bin/env node
/**
 * Offline-ish end-to-end check:
 *   - real Bilibili fetch (view/tags/danmaku/comments)
 *   - fake LLM (deterministic classification + summary)
 *   - real python-docx conversion
 *   - real plugin tool registration/pipeline
 *
 * Usage: node scripts/e2e.mjs [--bvid BV1owrpYKEtP]
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { findPython, validateDocx } from '../lib/docx.js'

const fence = '```'
const args = process.argv.slice(2)
const bvidIndex = args.indexOf('--bvid')
const bvid = bvidIndex >= 0 ? args[bvidIndex + 1] : 'BV1owrpYKEtP'
if (!bvid) {
  console.error('missing bvid')
  process.exit(2)
}

const classification = JSON.stringify({
  isCourse: true,
  subject: '人工智能',
  title: '机器学习课程知识笔记',
  keywords: ['机器学习', '监督学习', '过拟合'],
  confidence: 0.95,
  reason: 'e2e fake classification',
})
const summary = [
  '# 机器学习课程知识笔记',
  '',
  '> 一个用于验证 Word 管线的示例总结。',
  '',
  '## 学习目标',
  '- 验证内容抓取与文档生成',
  '',
  '## 核心知识点',
  '- **监督学习**',
  '  - 使用带标签数据',
  '- **过拟合**',
  '  - 正则化缓解',
  '',
  '## 关键概念与术语',
  '- **损失函数**：衡量预测误差',
  '',
  '## 弹幕与评论区洞察',
  '- 观众关注配套资料与学习路线',
  '',
  '## 思维导图',
  fence + 'mermaid',
  'mindmap',
  '  root((机器学习))',
  '    监督学习',
  '    过拟合',
  fence,
  '',
  '## 复习清单',
  '- [ ] 解释过拟合',
  '',
  '## 内容来源与覆盖度',
  '- 覆盖：真实 B 站元数据 + 弹幕 + 评论',
  '',
].join('\n')

const tools = {}
const ctx = {
  llm: {
    stream: ({ system }) =>
      (async function* () {
        yield {
          type: 'text-delta',
          text: String(system).includes('分类助手') ? classification : summary,
        }
      })(),
  },
  tools: {
    register: (definition) => {
      tools[definition.name] = definition
      return () => {}
    },
  },
  effect: (fn) => fn(),
  get: () => undefined,
}

const base = join(process.cwd(), '.tmp')
mkdirSync(base, { recursive: true })
const out = mkdtempSync(join(base, 'e2e-live-'))
const python = findPython()
if (!python) {
  console.error('python-docx not available; cannot validate Word output')
  process.exit(2)
}

apply(ctx, {
  enabled: true,
  pollIntervalMs: 99999999,
  rebuildOnStartup: false,
  fetchContent: true,
  outputDir: out,
  browser: { backend: 'manual' },
  delivery: { newSession: false },
  summary: { maxDanmaku: 40, maxComments: 10 },
})

const result = await tools.course_map_scan.execute({
  url: 'https://www.bilibili.com/video/' + bvid,
})
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(1)
for (const file of [result.noteDocx, result.manualDocx, join(out, '课程总览.docx')]) {
  if (!existsSync(file)) {
    console.error('missing', file)
    process.exit(1)
  }
  const facts = validateDocx(file, { pythonPath: python })
  console.log('validated', file.split('/').slice(-2).join('/'), facts.ok, facts.paragraphs, facts.tables)
  if (!facts.ok) process.exit(1)
}
const state = JSON.parse(readFileSync(join(out, '.state/state.json'), 'utf8'))
console.log('subjects:', Object.keys(state.subjects))
console.log('videos:', Object.keys(state.videos))
console.log('output:', out)
