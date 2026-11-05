import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeInstaller } from '../updater.mjs'

test('writeInstaller writes a backup-and-relaunch shell script', () => {
  const base = mkdtempSync(join(process.cwd(), '.tmp', 'updater-'))
  try {
    const app = join(base, 'Course Notes.app')
    const staged = join(base, 'staged', 'Course Notes.app')
    mkdirSync(join(app, 'Contents'), { recursive: true })
    mkdirSync(join(staged, 'Contents'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'Info.plist'), 'old')
    writeFileSync(join(staged, 'Contents', 'Info.plist'), 'new')
    const installer = writeInstaller({ appPath: app, stagedApp: staged, version: '1.0.1', dataHome: join(base, 'data') })
    const script = readFileSync(installer.scriptPath, 'utf8')
    assert.match(script, /Course Notes\.app/)
    assert.match(script, /update-backup/)
    assert.match(script, /open "\$APP"/)
    assert.equal(installer.version, '1.0.1')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
