import test from 'node:test'
import assert from 'node:assert/strict'
import { fallbackClassify, buildClassifyPrompt, titleKeywords } from '../lib/classify.js'

test('fallbackClassify recognizes AI courses', () => {
  const result = fallbackClassify('2025 吴恩达机器学习课程 入门教程', { tags: ['机器学习', '深度学习'] })
  assert.equal(result.isCourse, true)
  assert.equal(result.subject, '人工智能')
  assert.ok(result.keywords.length > 0)
})

test('fallbackClassify recognizes frontend/English/math', () => {
  assert.equal(fallbackClassify('React 前端开发实战教程').subject, '前端开发')
  assert.equal(fallbackClassify('雅思英语口语课程').subject, '英语')
  assert.equal(fallbackClassify('高等数学 考研复习 教程').subject, '数学')
})

test('fallbackClassify rejects entertainment', () => {
  assert.equal(fallbackClassify('搞笑段子合集 沙雕视频').isCourse, false)
  assert.equal(fallbackClassify('纯音乐 钢琴曲 歌单').isCourse, false)
})

test('buildClassifyPrompt includes existing subjects and hints', () => {
  const prompt = buildClassifyPrompt('课程', ['人工智能'], { tags: ['机器学习'], desc: '简介' })
  assert.match(prompt.user, /人工智能/)
  assert.match(prompt.user, /机器学习/)
  assert.match(prompt.user, /简介/)
})

test('titleKeywords extracts pieces', () => {
  assert.ok(titleKeywords('机器学习 - 监督学习 入门').includes('机器学习'))
})
