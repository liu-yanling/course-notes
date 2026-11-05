import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTabbitInventory, parseAppleScriptResult, isBrowserApp, chromiumVendorFor } from '../lib/browser.js'

test('parseTabbitInventory chooses the active tab', () => {
  const stdout = [
    'TABBIT_PLAYWRIGHT_INSTANCE=abc',
    JSON.stringify({
      currentTabId: null,
      tabs: [
        { tabId: 1, active: false, title: '首页', url: 'https://www.bilibili.com/' },
        { tabId: 2, active: true, title: '课程_哔哩哔哩_bilibili', url: 'https://www.bilibili.com/video/BV1owrpYKEtP' },
      ],
      total: 2,
    }),
  ].join('\n')
  const tab = parseTabbitInventory(stdout)
  assert.equal(tab.tabId, 2)
  assert.match(tab.url, /BV1owrpYKEtP/)
})

test('parseTabbitInventory uses currentTabId when present', () => {
  const stdout = JSON.stringify({
    currentTabId: 7,
    tabs: [
      { tabId: 7, active: false, title: 'A', url: 'https://example.com' },
      { tabId: 8, active: true, title: 'B', url: 'https://example.com/b' },
    ],
  })
  assert.equal(parseTabbitInventory(stdout).tabId, 7)
})

test('parseTabbitInventory tolerates garbage', () => {
  assert.equal(parseTabbitInventory('not json'), null)
  assert.equal(parseTabbitInventory('{"tabs":[]}'), null)
})

test('parseAppleScriptResult splits title and URL', () => {
  assert.deepEqual(parseAppleScriptResult('课程, https://www.bilibili.com/video/BV1owrpYKEtP'), {
    title: '课程',
    url: 'https://www.bilibili.com/video/BV1owrpYKEtP',
  })
  assert.equal(parseAppleScriptResult('no url'), null)
})

test('browser app maps', () => {
  assert.equal(isBrowserApp('Google Chrome'), true)
  assert.equal(isBrowserApp('Tabbit Browser'), true)
  assert.equal(isBrowserApp('Finder'), false)
  assert.equal(chromiumVendorFor('Google Chrome').label, 'Chrome')
  assert.equal(chromiumVendorFor('Safari'), null)
})
