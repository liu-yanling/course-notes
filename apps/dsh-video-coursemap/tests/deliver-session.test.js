import test from 'node:test'
import assert from 'node:assert/strict'
import { deliverToNewSession } from '../lib/deliver.js'

function fakeCtx(overrides = {}) {
  const calls = { create: [], followup: [], rename: [] }
  const handle = {
    agent: {
      session: { events: [] },
      followup: (message) => calls.followup.push(message),
    },
  }
  const ctx = {
    get: (name) => {
      if (overrides[name]) return overrides[name]
      if (name === 'agents') {
        return {
          create: async (input) => {
            calls.create.push(input)
            return handle
          },
        }
      }
      if (name === 'agentPresets') {
        return {
          resolve: async () => ({ id: 'standard' }),
          mount: async () => {},
        }
      }
      if (name === 'sessionTitle') {
        return {
          rename: (session, title) => calls.rename.push({ session, title }),
        }
      }
      return undefined
    },
    llm: { listProviders: () => [] },
  }
  return { ctx, calls, handle }
}

const config = {
  delivery: {
    sessionTitlePrefix: '📚',
    present: true,
    memory: true,
    cwd: '/tmp/workspace',
    newSession: true,
  },
  provider: null,
  model: null,
}

test('deliverToNewSession creates a standard session and prompts present + memory', async () => {
  const { ctx, calls } = fakeCtx()
  const result = await deliverToNewSession(ctx, config, {
    video: { title: '机器学习课程', subject: '人工智能', bvid: 'BV1owrpYKEtP' },
    noteDocx: '/tmp/note.docx',
    manualDocx: '/tmp/manual.docx',
    bullets: ['要点一'],
  })
  assert.equal(result.ok, true)
  assert.ok(result.sessionId.startsWith('session-'))
  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0].meta.cwd, '/tmp/workspace')
  assert.equal(calls.create[0].meta.agentPreset, 'standard')
  assert.equal(calls.followup.length, 1)
  const prompt = calls.followup[0].content[0].text
  assert.match(prompt, /present/)
  assert.match(prompt, /target=key/)
  assert.match(prompt, /note\.docx/)
  assert.match(prompt, /manual\.docx/)
  assert.equal(calls.rename.length, 1)
})

test('deliverToNewSession degrades without agents service', async () => {
  const ctx = { get: () => undefined }
  const result = await deliverToNewSession(ctx, config, {
    video: { title: 'A', subject: 'B' },
    noteDocx: '/tmp/x.docx',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /agents/)
})
