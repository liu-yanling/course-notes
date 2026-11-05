import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLocalSummary } from '../local-summary.mjs'

const content = {
  desc: '本视频介绍 RAG 的基本流程。包括分片、索引、召回与重排。',
  tags: ['RAG', '知识库', '大模型'],
  pages: [
    { page: 1, title: 'RAG 技术解析', duration: 300 },
    { page: 2, title: '文本分块与索引', duration: 400 },
  ],
  danmaku: ['讲得很清楚', '数据清洗很重要'],
  comments: [{ text: '求配套资料', like: 3 }],
  coverage: { desc: true, tags: 3, chapters: 2, subtitle: 0, danmaku: 2, comments: 1 },
}

test('local summary contains required sections and a mindmap', () => {
  const markdown = buildLocalSummary({ title: 'RAG 入门', subject: '大模型应用', keywords: ['RAG'], content })
  for (const heading of ['## 学习目标', '## 核心知识点', '## 关键概念与术语', '## 弹幕与评论区洞察', '## 思维导图', '## 复习清单', '## 内容来源与覆盖度']) {
    assert.match(markdown, new RegExp(heading.replace('## ', '## ')))
  }
  assert.match(markdown, /```mermaid\nmindmap/)
  assert.match(markdown, /RAG/)
})

test('local summary degrades without content', () => {
  const markdown = buildLocalSummary({ title: '一个视频', subject: '通识', keywords: [], content: null })
  assert.match(markdown, /# 一个视频/)
  assert.match(markdown, /## 核心知识点/)
  assert.match(markdown, /## 内容来源与覆盖度/)
})
