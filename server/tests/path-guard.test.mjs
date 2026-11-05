import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertInside, assertRealInside, isInside, resolveOutputPath } from '../path-guard.mjs'

test('isInside accepts descendants and root only', () => {
  assert.equal(isInside('/tmp/root', '/tmp/root/a'), true)
  assert.equal(isInside('/tmp/root', '/tmp/root'), true)
  assert.equal(isInside('/tmp/root', '/tmp/root-other'), false)
  assert.equal(isInside('/tmp/root', '/tmp/root/../outside'), false)
})

test('resolveOutputPath blocks traversal', () => {
  assert.equal(resolveOutputPath('/tmp/root', 'a/b.docx'), '/tmp/root/a/b.docx')
  assert.throws(() => resolveOutputPath('/tmp/root', '../x'), /不在输出目录内/)
})

test('assertRealInside rejects symlink escape', () => {
  const base = join(process.cwd(), '.tmp')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'guard-'))
  const outside = mkdtempSync(join(base, 'guard-out-'))
  try {
    writeFileSync(join(outside, 'secret.docx'), 'x')
    symlinkSync(join(outside, 'secret.docx'), join(dir, 'link.docx'))
    assert.throws(() => assertRealInside(dir, join(dir, 'link.docx')), /不在输出目录内/)
    assertInside(dir, join(dir, 'missing.docx'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
