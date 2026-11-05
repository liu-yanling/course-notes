import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanBrowserTitle,
  extractBvid,
  isBilibiliVideoUrl,
  isBilibiliNonVideoPage,
  parseJson,
  sanitizeFileName,
  sanitizeSubject,
  bigramSimilarity,
  stripFirstH1,
} from '../lib/util.js'

test('cleanBrowserTitle strips browser and platform suffixes', () => {
  assert.equal(cleanBrowserTitle('课程标题 - Google Chrome'), '课程标题')
  assert.equal(cleanBrowserTitle('课程标题_哔哩哔哩_bilibili'), '课程标题')
  assert.equal(cleanBrowserTitle('标题 - bilibili'), '标题')
})

test('extractBvid handles URLs and text', () => {
  assert.equal(extractBvid('https://www.bilibili.com/video/BV1owrpYKEtP/?p=1'), 'BV1owrpYKEtP')
  assert.equal(extractBvid('BV1owrpYKEtP'), 'BV1owrpYKEtP')
  assert.equal(extractBvid('no video here'), null)
})

test('Bilibili URL classification', () => {
  assert.equal(isBilibiliVideoUrl('https://www.bilibili.com/video/BV1owrpYKEtP'), true)
  assert.equal(isBilibiliVideoUrl('https://www.bilibili.com/video/av123'), true)
  assert.equal(isBilibiliVideoUrl('https://www.bilibili.com/'), false)
  assert.equal(isBilibiliNonVideoPage('https://www.bilibili.com/video/BV1owrpYKEtP'), false)
  assert.equal(isBilibiliNonVideoPage('https://search.bilibili.com/all?keyword=x'), true)
})

test('parseJson repairs fenced and loose JSON', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJson('```json\n{"a":2}\n```'), { a: 2 })
  assert.deepEqual(parseJson('前文 {"a":3,} 后文'), { a: 3 })
})

test('sanitize helpers keep CJK and drop path chars', () => {
  assert.match(sanitizeFileName('a/b:c*?'), /^a_b_c_/)
  assert.equal(sanitizeSubject('机器学习'), '机器学习')
  assert.equal(sanitizeSubject('a/b'), 'ab')
})

test('bigramSimilarity is stable', () => {
  assert.equal(bigramSimilarity('机器学习', '机器学习'), 1)
  assert.ok(bigramSimilarity('机器学习入门', '机器学习') > 0.5)
  assert.equal(bigramSimilarity('', 'x'), 0)
})

test('stripFirstH1 removes only the first heading', () => {
  assert.equal(stripFirstH1('# 标题\n\n正文\n## 小节'), '正文\n## 小节')
})
