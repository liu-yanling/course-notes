#!/usr/bin/env node
/**
 * Smoke-test a built Course Notes.app on macOS:
 * launch with an isolated data dir, wait for the local server, verify the UI
 * endpoint, verify the bundled Python can import python-docx, then stop.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const appArg = process.argv[2] || 'dist/build/Course Notes.app'
const appPath = resolve(appArg)
const executable = join(appPath, 'Contents', 'MacOS', 'CourseNotes')
const python = join(appPath, 'Contents', 'Resources', 'python', 'bin', 'python3')

if (!existsSync(executable)) {
  console.error('app executable not found: ' + executable)
  process.exit(1)
}

const dataDir = mkdtempSync(join(tmpdir(), 'course-notes-smoke-'))
const env = { ...process.env, COURSE_NOTES_DATA_DIR: dataDir }
const child = spawn(executable, [], { env, detached: true, stdio: 'ignore' })
child.unref()

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:43110/api/health', { signal: AbortSignal.timeout(1000) })
      if (response.ok) return await response.json()
    } catch {
      /* retry */
    }
    await sleep(500)
  }
  throw new Error('server did not become healthy')
}

try {
  const health = await waitForServer()
  const status = await (await fetch('http://127.0.0.1:43110/api/status')).json()
  const page = await (await fetch('http://127.0.0.1:43110/')).text()
  if (!page.includes('course notes')) throw new Error('page missing course notes')
  if (!status.ok) throw new Error('status not ok')
  if (!existsSync(python)) throw new Error('bundled python missing')
  const pythonCheck = spawnSync(python, ['-c', 'import docx; print(docx.__version__)'], { encoding: 'utf8', timeout: 20000 })
  if (pythonCheck.status !== 0) throw new Error('python-docx import failed: ' + (pythonCheck.stderr || ''))
  console.log('SMOKE_OK ' + JSON.stringify({ version: health.version, port: health.port, docx: pythonCheck.stdout.trim() }))
  await fetch('http://127.0.0.1:43110/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'shutdown' }),
  }).catch(() => {})
  await sleep(400)
} finally {
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* ignore */ }
  spawnSync('/usr/bin/pkill', ['-x', 'CourseNotesMenu'], { timeout: 5000 })
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
}
