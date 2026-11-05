import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createAppServer } from '../app.mjs'
import { normalizeConfig } from '../config.mjs'

const fakePipeline = {
  async runTask() { return { ok: true } },
  abort() {},
}

test('server exposes health, status, history and static page', async () => {
  const base = join(process.cwd(), '.tmp')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'app-'))
  const config = normalizeConfig({ outputDir: dir, llm: { provider: 'local', model: 'local', baseUrl: '', useDshKey: false } })
  const app = createAppServer({ config, autoStart: false, writeRuntime: false, pipeline: fakePipeline })
  const port = await app.start({ port: 0 })
  try {
    const health = await (await fetch('http://127.0.0.1:' + port + '/api/health')).json()
    assert.equal(health.ok, true)
    const status = await (await fetch('http://127.0.0.1:' + port + '/api/status')).json()
    assert.equal(status.ok, true)
    assert.equal(status.port, port)
    assert.equal(status.config.outputDir, dir)
    const history = await (await fetch('http://127.0.0.1:' + port + '/api/history')).json()
    assert.equal(history.ok, true)
    const page = await fetch('http://127.0.0.1:' + port + '/')
    assert.equal(page.status, 200)
    assert.match(await page.text(), /course notes/)
    const badDoc = await fetch('http://127.0.0.1:' + port + '/api/doc?path=' + encodeURIComponent('../server/config.json'))
    assert.equal(badDoc.status, 400)
    const crossOrigin = await fetch('http://127.0.0.1:' + port + '/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ action: 'start' }),
    })
    assert.equal(crossOrigin.status, 403)
    const badOpen = await fetch('http://127.0.0.1:' + port + '/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/etc/passwd' }),
    })
    assert.equal(badOpen.status, 400)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
