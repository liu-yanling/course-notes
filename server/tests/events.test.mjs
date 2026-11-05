import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventHub } from '../events.mjs'

function fakeRes() {
  const writes = []
  return {
    writes,
    writeHead(status, headers) { writes.push({ type: 'head', status, headers }) },
    write(chunk) { writes.push({ type: 'data', chunk }) },
    end() { writes.push({ type: 'end' }) },
    on() {},
  }
}

function fakeReq() {
  return { headers: { host: '127.0.0.1:43110' }, on() {} }
}

test('event hub stores polls and sends hello snapshot', () => {
  const hub = createEventHub({ maxPolls: 2 })
  hub.broadcast({ type: 'poll', decision: 'seen', title: 'a' })
  hub.broadcast({ type: 'poll', decision: 'new', title: 'b' })
  hub.broadcast({ type: 'poll', decision: 'new', title: 'c' })
  assert.equal(hub.getPolls().length, 2)
  assert.equal(hub.getPolls()[0].title, 'c')
  const res = fakeRes()
  hub.subscribe(fakeReq(), res)
  const hello = res.writes.find((entry) => entry.type === 'data' && entry.chunk.includes('hello'))
  assert.ok(hello)
  assert.match(hello.chunk, /seen|new/)
  hub.closeAll()
})

test('event hub sends later events to subscribers', () => {
  const hub = createEventHub()
  const res = fakeRes()
  hub.subscribe(fakeReq(), res)
  hub.broadcast({ type: 'status', enabled: true, running: true })
  assert.ok(res.writes.some((entry) => entry.type === 'data' && entry.chunk.includes('"enabled":true')))
  hub.closeAll()
})
