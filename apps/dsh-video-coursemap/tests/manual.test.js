import test from 'node:test'
import assert from 'node:assert/strict'
import { renderVideoNote, renderSubjectManual, renderOverview, buildVideoMeta } from '../lib/manual.js'
import { emptyState, upsertVideo } from '../lib/state.js'

test('renderVideoNote inserts meta quote after title', () => {
  const meta = buildVideoMeta({ title: '课程', subject: '人工智能', addedAt: Date.now() }, null)
  const out = renderVideoNote('# 课程\n\n正文', meta)
  assert.match(out, /^# 课程/)
  assert.match(out, /学科：人工智能/)
})

test('renderSubjectManual contains overview and video sections', () => {
  const state = emptyState()
  const video = { bvid: 'BV1', title: '课程A', subject: '人工智能', addedAt: Date.now(), markdown: '# 课程A\n\n## 核心知识点\n- A' }
  upsertVideo(state, video)
  const md = renderSubjectManual('人工智能', [video], state)
  assert.match(md, /# 人工智能 学习手册/)
  assert.match(md, /## 学科总览/)
  assert.match(md, /## 课程A/)
})

test('renderOverview lists subjects and videos', () => {
  const state = emptyState()
  upsertVideo(state, { bvid: 'BV1', title: '课程A', subject: '人工智能', addedAt: Date.now(), noteDocx: '/tmp/x.docx' })
  const md = renderOverview(state)
  assert.match(md, /# 视频课程知识地图/)
  assert.match(md, /人工智能/)
  assert.match(md, /视频笔记\/x.docx/)
})
