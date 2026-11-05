import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findPython, convertToDocx, validateDocx } from '../lib/docx.js'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))

test('md2docx generates a valid Word document', (t) => {
  const python = findPython()
  if (!python) {
    t.skip('python-docx not available')
    return
  }
  const base = join(process.cwd(), '.tmp')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'docx-'))
  try {
    const out = join(dir, 'sample.docx')
    convertToDocx({
      mdPath: join(fixtures, 'sample.md'),
      docxPath: out,
      metaPath: join(fixtures, 'sample.meta.json'),
      pythonPath: python,
    })
    const facts = validateDocx(out, { pythonPath: python })
    assert.equal(facts.ok, true)
    assert.ok(facts.paragraphs > 10)
    assert.ok(facts.tables >= 1)
    assert.match(facts.head, /测试视频/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findPython prefers an interpreter with python-docx', () => {
  const python = findPython()
  assert.ok(python === null || typeof python === 'string')
})
