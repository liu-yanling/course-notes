import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, patchConfig, publicConfig, engineConfig } from '../config.mjs'

test('normalizeConfig defaults and clamps', () => {
  const config = normalizeConfig({ pollIntervalMs: 1, stablePolls: 9, backend: 'nope' })
  assert.equal(config.pollIntervalMs, 3000)
  assert.equal(config.stablePolls, 5)
  assert.equal(config.backend, 'auto')
  assert.equal(config.server.host, '127.0.0.1')
  assert.equal(config.llm.provider, 'deepseek')
})

test('normalizeConfig keeps a valid config and normalizes provider', () => {
  const config = normalizeConfig({
    pollIntervalMs: 5000,
    stablePolls: 1,
    backend: 'tabbit',
    outputDir: '/tmp/course',
    llm: { provider: 'ollama', model: '', baseUrl: 'http://127.0.0.1:11434/' }
  })
  assert.equal(config.pollIntervalMs, 5000)
  assert.equal(config.stablePolls, 1)
  assert.equal(config.backend, 'tabbit')
  assert.equal(config.llm.model, 'deepseek-r1:7b')
  assert.equal(config.llm.baseUrl, 'http://127.0.0.1:11434')
})

test('patchConfig merges nested llm and clamps', () => {
  const base = normalizeConfig({ pollIntervalMs: 15000 })
  const next = patchConfig(base, { llm: { provider: 'local' }, pollIntervalMs: 9999999 })
  assert.equal(next.llm.provider, 'local')
  assert.equal(next.llm.model, 'local')
  assert.equal(next.pollIntervalMs, 600000)
})

test('publicConfig never exposes apiKey', () => {
  const config = normalizeConfig({ llm: { provider: 'deepseek', apiKey: 'sk-secret-test' } })
  const pub = publicConfig(config)
  assert.equal(pub.llm.apiKey, undefined)
  assert.equal(pub.llm.apiKeySet, true)
  assert.equal(JSON.stringify(pub).includes('sk-secret-test'), false)
})

test('engineConfig uses server settings', () => {
  const config = normalizeConfig({ outputDir: '/tmp/x', backend: 'chromium', llm: { provider: 'ollama', model: 'm' } })
  const engine = engineConfig(config)
  assert.equal(engine.outputDir, '/tmp/x')
  assert.equal(engine.browser.backend, 'chromium')
  assert.equal(engine.provider, 'ollama')
  assert.equal(engine.model, 'm')
  assert.equal(engine.delivery.newSession, false)
})
