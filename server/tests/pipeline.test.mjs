import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createPipeline } from '../pipeline.mjs'
import { normalizeConfig, engineConfig, configPaths } from '../config.mjs'
import { loadState } from '../../apps/dsh-video-coursemap/lib/state.js'
import { findPython } from '../../apps/dsh-video-coursemap/lib/docx.js'

test('local pipeline generates note, manual, overview and dedupes', async (t) => {
  if (!findPython()) { t.skip('python-docx unavailable'); return }
  const base = join(process.cwd(), '.tmp')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'pipe-'))
  const config = normalizeConfig({
    outputDir: dir,
    fetchContent: false,
    pollIntervalMs: 15000,
    stablePolls: 2,
    llm: { provider: 'local', model: 'local', baseUrl: '', useDshKey: false }
  })
  const engine = engineConfig(config)
  const paths = configPaths(config)
  const state = loadState(paths.statePath)
  const events = []
  const pipeline = createPipeline({ config, engine, state, paths, emit: (event) => events.push(event) })
  try {
    const first = await pipeline.runTask({ source: 'manual', title: '测试课程：机器学习入门', url: '' })
    assert.equal(first.ok, true)
    assert.ok(existsSync(first.noteDocx))
    assert.ok(existsSync(first.manualDocx))
    assert.ok(existsSync(join(dir, '课程总览.docx')))
    assert.ok(events.some((event) => event.type === 'summary:done'))
    assert.ok(events.some((event) => event.type === 'task' && event.stage === 'done'))
    const stateAfter = JSON.parse(readFileSync(paths.statePath, 'utf8'))
    assert.ok(Object.keys(stateAfter.videos).length >= 1)
    assert.ok(Object.keys(stateAfter.seen).length >= 1)
    const second = await pipeline.runTask({ source: 'manual', title: '测试课程：机器学习入门', url: '' })
    assert.equal(second.skipped, 'seen')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
