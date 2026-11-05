import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { findPython, validateDocx } from '../lib/docx.js'

const fence = '```'

function fakeCtx(tools) {
  const classification = JSON.stringify({
    isCourse: true,
    subject: '人工智能',
    title: '测试课程：机器学习入门',
    keywords: ['机器学习', '监督学习'],
    confidence: 0.95,
    reason: '课程',
  })
  const summary = [
    '# 测试课程：机器学习入门',
    '',
    '> 一句话总结。',
    '',
    '## 学习目标',
    '- 理解监督学习',
    '',
    '## 核心知识点',
    '- **监督学习**',
    '  - 使用带标签数据',
    '- **过拟合**',
    '  - 正则化',
    '',
    '## 关键概念与术语',
    '- **损失函数**：衡量误差',
    '',
    '## 弹幕与评论区洞察',
    '- 观众关注配套资料',
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
    '- 覆盖：测试数据',
    '',
  ].join('\n')
  return {
    llm: {
      stream: ({ system }) =>
        (async function* () {
          const text = String(system).includes('分类助手') ? classification : summary
          yield { type: 'text-delta', text }
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
}

test('plugin registers tools and runs a complete offline pipeline', async (t) => {
  const python = findPython()
  if (!python) {
    t.skip('python-docx not available')
    return
  }
  const base = join(process.cwd(), '.tmp')
  mkdirSync(base, { recursive: true })
  const out = mkdtempSync(join(base, 'pipeline-'))
  const tools = {}
  try {
    apply(fakeCtx(tools), {
      enabled: true,
      pollIntervalMs: 99999999,
      rebuildOnStartup: false,
      fetchContent: false,
      outputDir: out,
      browser: { backend: 'manual' },
      delivery: { newSession: false },
    })
    for (const name of ['course_map_status', 'course_map_scan', 'course_map_deliver', 'course_map_rebuild']) {
      assert.ok(tools[name], name + ' should be registered')
    }
    const result = await tools.course_map_scan.execute({ title: '测试课程：机器学习入门' })
    assert.equal(result.ok, true)
    assert.equal(result.subject, '人工智能')
    assert.equal(result.isNewSubject, true)
    assert.ok(existsSync(result.noteDocx))
    assert.ok(existsSync(result.manualDocx))
    assert.ok(existsSync(join(out, '课程总览.docx')))
    assert.equal(validateDocx(result.noteDocx, { pythonPath: python }).ok, true)
    assert.equal(validateDocx(result.manualDocx, { pythonPath: python }).ok, true)
    const state = JSON.parse(readFileSync(join(out, '.state/state.json'), 'utf8'))
    assert.ok(state.subjects['人工智能'])
    assert.equal(state.subjects['人工智能'].videos.length, 1)
    assert.ok(state.seen['title:'] || Object.keys(state.seen).length > 0)
    const status = await tools.course_map_status.execute()
    assert.equal(status.ok, true)
    assert.match(status.message, /人工智能/)
    const rebuild = await tools.course_map_rebuild.execute({})
    assert.equal(rebuild.ok, true)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
