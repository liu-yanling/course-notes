import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { compareVersions, checkForUpdate } from '../update.mjs'

test('compareVersions handles normal and beta versions', () => {
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareVersions('v1.2.0-beta.1', '1.1.9'), 1)
})

test('checkForUpdate reads a manifest and detects an update', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: '1.0.1', downloadUrl: 'https://example.com/app.dmg', notes: 'fix' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const result = await checkForUpdate({
      currentVersion: '1.0.0',
      updateUrl: 'http://127.0.0.1:' + port + '/version.json',
    })
    assert.equal(result.ok, true)
    assert.equal(result.updateAvailable, true)
    assert.equal(result.latestVersion, '1.0.1')
    assert.equal(result.downloadUrl, 'https://example.com/app.dmg')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('checkForUpdate returns unconfigured without a URL', async () => {
  const result = await checkForUpdate({ currentVersion: '1.0.0', updateUrl: '' })
  assert.equal(result.ok, false)
  assert.equal(result.configured, false)
})
