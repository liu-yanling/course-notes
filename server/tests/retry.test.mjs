import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { clearRetry, readRetry, retryDelay, writeRetry } from '../retry.mjs'

test('retryDelay follows the backoff ladder', () => {
  assert.equal(retryDelay(1), 30000)
  assert.equal(retryDelay(2), 120000)
  assert.equal(retryDelay(3), 300000)
  assert.equal(retryDelay(99), 300000)
})

test('retry state round-trips through disk', () => {
  const dir = mkdtempSync(join(process.cwd(), '.tmp', 'retry-'))
  const file = join(dir, 'retry.json')
  try {
    const state = { observation: { title: '课程' }, attempts: 1, nextAt: 1, error: 'boom', at: 2 }
    assert.equal(writeRetry(file, state), true)
    assert.deepEqual(readRetry(file), state)
    clearRetry(file)
    assert.equal(readRetry(file), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
