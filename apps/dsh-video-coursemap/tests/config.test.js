import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../lib/config.js'

function tempDir() {
  const base = join(process.cwd(), '.tmp')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, 'config-'))
}

test('resolveConfig defaults outputDir under home', () => {
  const pluginDir = tempDir()
  try {
    const config = resolveConfig({}, { pluginDir, home: pluginDir })
    assert.equal(config.outputDir, join(pluginDir, '课程知识地图'))
    assert.equal(config.browser.backend, 'auto')
    assert.equal(config.delivery.newSession, true)
  } finally {
    rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('resolveConfig merges config.json and row config', () => {
  const pluginDir = tempDir()
  try {
    writeFileSync(join(pluginDir, 'config.json'), JSON.stringify({ outputDir: '/tmp/out', browser: { chromeRecencyMinutes: 12 } }))
    const config = resolveConfig({ browser: { backend: 'tabbit' } }, { pluginDir, home: pluginDir })
    assert.equal(config.outputDir, '/tmp/out')
    assert.equal(config.browser.chromeRecencyMinutes, 12)
    assert.equal(config.browser.backend, 'tabbit')
  } finally {
    rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('resolveConfig rejects unknown/invalid values', () => {
  const pluginDir = tempDir()
  try {
    assert.throws(() => resolveConfig({ nope: true }, { pluginDir, home: pluginDir }), /未知配置项/)
    assert.throws(() => resolveConfig({ pollIntervalMs: 0 }, { pluginDir, home: pluginDir }), /正数/)
    assert.throws(() => resolveConfig({ browser: { backend: 'nope' } }, { pluginDir, home: pluginDir }), /backend/)
  } finally {
    rmSync(pluginDir, { recursive: true, force: true })
  }
})
