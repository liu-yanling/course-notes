import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDeliveryPrompt } from '../lib/deliver.js'

test('buildDeliveryPrompt demands present and memory', () => {
  const config = { delivery: { sessionTitlePrefix: '📚', present: true, memory: true } }
  const prompt = buildDeliveryPrompt(
    {
      video: { title: '课程A', subject: '人工智能', bvid: 'BV1owrpYKEtP' },
      noteDocx: '/tmp/a.docx',
      manualDocx: '/tmp/b.docx',
      bullets: ['要点1', '要点2'],
    },
    config,
  )
  assert.match(prompt, /present/)
  assert.match(prompt, /target=key/)
  assert.match(prompt, /target=project/)
  assert.match(prompt, /\/tmp\/a\.docx/)
  assert.match(prompt, /\/tmp\/b\.docx/)
  assert.match(prompt, /要点1/)
})

test('buildDeliveryPrompt can disable memory', () => {
  const config = { delivery: { sessionTitlePrefix: '', present: true, memory: false } }
  const prompt = buildDeliveryPrompt(
    { video: { title: 'A', subject: 'B' }, noteDocx: '/tmp/a.docx', manualDocx: null },
    config,
  )
  assert.doesNotMatch(prompt, /target=key/)
  assert.match(prompt, /present/)
})
