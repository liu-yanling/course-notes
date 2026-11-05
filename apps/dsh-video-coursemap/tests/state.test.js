import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyState,
  seenKey,
  isSeen,
  markSeen,
  matchSubject,
  upsertVideo,
  subjectVideos,
  pruneSeen,
} from '../lib/state.js'

test('seenKey prefers bvid', () => {
  assert.equal(seenKey({ bvid: 'BV1owrpYKEtP', title: 'x' }), 'bvid:BV1owrpYKEtP')
  assert.match(seenKey({ title: '机器学习' }), /^title:/)
  assert.equal(seenKey({}), null)
})

test('isSeen/markSeen round trip by bvid and title', () => {
  const state = emptyState()
  markSeen(state, { bvid: 'BV1owrpYKEtP', title: '课程' }, 'course', { subject: '人工智能' })
  assert.equal(isSeen(state, { bvid: 'BV1owrpYKEtP' }), true)
  assert.equal(isSeen(state, { title: '课程' }), true)
  assert.equal(isSeen(state, { title: '另一个课程' }), false)
})

test('matchSubject reuses exact and close variants', () => {
  const subjects = { 机器学习: {}, 前端开发: {} }
  assert.equal(matchSubject('机器学习', subjects), '机器学习')
  assert.equal(matchSubject('机器学习入门', subjects), '机器学习')
  assert.equal(matchSubject('英语', subjects), null)
})

test('upsertVideo builds subject and video records', () => {
  const state = emptyState()
  const first = upsertVideo(state, { bvid: 'BV1', title: 'A', subject: '人工智能' })
  assert.equal(first.isNewSubject, true)
  assert.equal(first.isNewVideo, true)
  const second = upsertVideo(state, { bvid: 'BV2', title: 'B', subject: '人工智能' })
  assert.equal(second.isNewSubject, false)
  assert.equal(second.isNewVideo, true)
  assert.equal(subjectVideos(state, '人工智能').length, 2)
})

test('pruneSeen enforces limits', () => {
  const state = emptyState()
  for (let i = 0; i < 10; i += 1) {
    state.seen['bvid:BV' + i] = { at: i, title: 't' + i }
  }
  pruneSeen(state, 3, Number.MAX_SAFE_INTEGER)
  assert.equal(Object.keys(state.seen).length, 3)
})
