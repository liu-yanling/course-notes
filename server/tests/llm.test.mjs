import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDshKey, resolveKey, keyStatus } from '../llm.mjs'

function tempCreds(text) {
  const base = join(process.cwd(), '.tmp')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'creds-'))
  const file = join(dir, '.credentials.yaml')
  writeFileSync(file, text)
  return { dir, file }
}

test('readDshKey parses refs block', () => {
  const { dir, file } = tempCreds('version: 1\nrefs:\n  DEEPSEEK_API_KEY: "sk-test-123"\n')
  try {
    assert.equal(readDshKey(file), 'sk-test-123')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveKey priority keychain > env > config', () => {
  const config = { llm: { apiKey: 'sk-config', useDshKey: true } }
  assert.equal(resolveKey(config, { env: { DEEPSEEK_API_KEY: 'sk-env' }, keychain: 'sk-chain' }).source, 'keychain')
  assert.equal(resolveKey(config, { env: { DEEPSEEK_API_KEY: 'sk-env' }, keychain: '' }).source, 'env')
  assert.equal(resolveKey(config, { env: {}, keychain: '' }).source, 'config')
  assert.equal(resolveKey({ llm: { apiKey: '', useDshKey: true } }, { env: { DEEPSEEK_API_KEY: 'sk-env' }, keychain: '' }).source, 'env')
  const none = resolveKey({ llm: { apiKey: '', useDshKey: false } }, { env: {}, keychain: '' })
  assert.equal(none.source, 'none')
})

test('keyStatus does not expose the key', () => {
  const config = { llm: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-secret', useDshKey: true } }
  const status = keyStatus(config)
  assert.equal(status.keySet, true)
  assert.equal(status.keySource, 'config')
  assert.equal(JSON.stringify(status).includes('sk-secret'), false)
})
