/**
 * dsh-video-coursemap — foreground browser / current video detection.
 *
 * macOS reality:
 *   - Tabbit Browser can be asked for its current tab through the local
 *     tabbit-cli bridge (exact title + URL).
 *   - Chromium-family browsers expose no tab API without automation
 *     permission, so we use a deliberately narrow approximation: the newest
 *     Bilibili video URL in the browser's History within a recency window.
 *   - AppleScript is attempted when allowed; failures are cached and silent.
 *   - The frontmost application is read with /usr/bin/lsappinfo, which needs
 *     no TCC permission.
 *
 * All network-free parse helpers are exported for tests.
 * @module dsh-video-coursemap/browser
 */

import { execFile, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  cleanBrowserTitle,
  extractBvid,
  isBilibiliNonVideoPage,
  isBilibiliVideoUrl,
} from './util.js'

const execFileP = promisify(execFile)

const TABBIT_CLI = join(homedir(), '.local/bin/tabbit-cli')

const BROWSER_APPS = new Set([
  'Google Chrome',
  'Chromium',
  'Microsoft Edge',
  'Brave Browser',
  'Arc',
  'Safari',
  'Firefox',
  'Tabbit Browser',
  'Tabbit浏览器',
  'Tabbit 浏览器',
  '谷歌浏览器',
  '哔哩哔哩',
  'Bilibili',
])

const CHROMIUM_APPS = {
  'Google Chrome': { root: 'Google/Chrome', label: 'Chrome' },
  '谷歌浏览器': { root: 'Google/Chrome', label: 'Chrome' },
  Chromium: { root: 'Chromium', label: 'Chromium' },
  'Microsoft Edge': { root: 'Microsoft Edge', label: 'Edge' },
  'Brave Browser': { root: 'BraveSoftware/Brave-Browser', label: 'Brave' },
  Arc: { root: 'Arc/User Data', label: 'Arc' },
}

const APPLESCRIPT_APPS = {
  'Google Chrome': 'Google Chrome',
  Chromium: 'Chromium',
  'Microsoft Edge': 'Microsoft Edge',
  'Brave Browser': 'Brave Browser',
  Arc: 'Arc',
  Safari: 'Safari',
  '谷歌浏览器': 'Google Chrome',
}

const TABBIT_NAMES = new Set(['Tabbit Browser', 'Tabbit浏览器', 'Tabbit 浏览器'])

let frontCache = { at: 0, name: '' }
const appleScriptFailures = new Map()

/** Read the frontmost application display name (no TCC permission needed). */
export async function frontmostApp({ force = false, now = Date.now() } = {}) {
  if (!force && frontCache.name && now - frontCache.at < 5000) return frontCache.name
  if (process.platform !== 'darwin') return ''
  try {
    const front = await execFileP('/usr/bin/lsappinfo', ['front'], { timeout: 4000 })
    const asn = String(front.stdout ?? '').trim()
    if (!asn) return ''
    const info = await execFileP('/usr/bin/lsappinfo', ['info', '-only', 'name', asn], {
      timeout: 4000,
    })
    const match = /"LSDisplayName"="([^"]*)"/.exec(String(info.stdout ?? ''))
    const name = match ? match[1] : ''
    frontCache = { at: now, name }
    return name
  } catch {
    return ''
  }
}

export function isTabbitApp(name) {
  return TABBIT_NAMES.has(String(name ?? '').trim())
}

export function isBrowserApp(name) {
  return BROWSER_APPS.has(String(name ?? '').trim()) || isTabbitApp(name)
}

export function chromiumVendorFor(appName) {
  return CHROMIUM_APPS[String(appName ?? '').trim()] ?? null
}

/** Parse the JSON inventory printed by `tabbit-cli create`. */
export function parseTabbitInventory(stdout) {
  const text = String(stdout ?? '')
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  let payload = null
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue
    try {
      payload = JSON.parse(lines[i])
      break
    } catch {
      /* try earlier */
    }
  }
  if (!payload || !Array.isArray(payload.tabs)) return null
  const byId = (id) => payload.tabs.find((tab) => Number(tab?.tabId) === Number(id))
  const chosen =
    (payload.currentTabId != null ? byId(payload.currentTabId) : null) ??
    payload.tabs.find((tab) => tab?.active === true) ??
    null
  if (!chosen) return null
  return {
    title: String(chosen.title ?? ''),
    url: String(chosen.url ?? ''),
    tabId: chosen.tabId ?? null,
    total: Number(payload.total ?? payload.tabs.length),
  }
}

/** Ask Tabbit Browser for its current tab. */
export async function detectTabbit({ task = 'dsh-course-map', timeoutMs = 12000 } = {}) {
  if (!existsSync(TABBIT_CLI)) return null
  try {
    const { stdout } = await execFileP(TABBIT_CLI, ['create', '--task', task], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    })
    return parseTabbitInventory(stdout)
  } catch {
    return null
  }
}

/** Release the Tabbit task created by the poller (best effort). */
export async function finishTabbit({ task = 'dsh-course-map' } = {}) {
  if (!existsSync(TABBIT_CLI)) return
  try {
    await execFileP(TABBIT_CLI, ['finish', '--task', task], { timeout: 5000 })
  } catch {
    /* the task may already have expired */
  }
}

function chromiumProfiles(root) {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || entry.name.startsWith('Profile ')))
      .map((entry) => join(root, entry.name))
      .filter((dir) => existsSync(join(dir, 'History')))
  } catch {
    return []
  }
}

function queryHistory(historyPath, tempRoot) {
  const tempDir = mkdtempSync(join(tempRoot, 'course-hist-'))
  const db = join(tempDir, 'History')
  try {
    copyFileSync(historyPath, db)
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = historyPath + suffix
      if (existsSync(sidecar)) {
        try {
          copyFileSync(sidecar, db + suffix)
        } catch {
          /* optional */
        }
      }
    }
    const sql =
      "SELECT last_visit_time, title, url FROM urls " +
      "WHERE url LIKE '%bilibili.com/video/%' ORDER BY last_visit_time DESC LIMIT 30;"
    const { stdout } = requireSqlite(db, sql)
    const rows = []
    for (const line of String(stdout ?? '').split(/\r?\n/)) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const timeRaw = parts.shift()
      const url = parts.pop()
      const title = parts.join('\t')
      const chromeUs = Number(timeRaw)
      if (!Number.isFinite(chromeUs) || chromeUs <= 0) continue
      const visitedAt = Math.floor(chromeUs / 1000 - 11644473600000)
      const bvid = extractBvid(url)
      if (!bvid) continue
      rows.push({ visitedAt, title, url, bvid })
    }
    return rows
  } catch {
    return []
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

function requireSqlite(db, sql) {
  const result = spawnSync('/usr/bin/sqlite3', ['-noheader', '-separator', '\t', db, sql], {
    encoding: 'utf8',
    timeout: 8000,
  })
  if (result.status !== 0) throw new Error(String(result.stderr ?? 'sqlite3 failed'))
  return { stdout: result.stdout ?? '' }
}

/** Approximate the current Chromium video from History. */
export async function detectChromium({
  appName,
  now = Date.now(),
  recencyMinutes = 30,
  home = homedir(),
} = {}) {
  const vendor = chromiumVendorFor(appName)
  if (!vendor) return null
  const base = join(home, 'Library/Application Support', vendor.root)
  const profiles = chromiumProfiles(base)
  if (profiles.length === 0) return null
  const oldest = now - Math.max(1, recencyMinutes) * 60 * 1000
  const candidates = []
  for (const profile of profiles) {
    let mtime = 0
    try {
      mtime = statSync(join(profile, 'History')).mtimeMs
    } catch {
      continue
    }
    // A profile that has not been written since the recency window cannot
    // contain a fresh visit; skip the copy.
    if (mtime < oldest - 60 * 1000) continue
    for (const row of queryHistory(join(profile, 'History'), tmpdir())) {
      if (row.visitedAt >= oldest) candidates.push({ ...row, profile })
    }
  }
  candidates.sort((a, b) => b.visitedAt - a.visitedAt)
  const top = candidates[0]
  if (!top) return null
  return {
    title: cleanBrowserTitle(top.title),
    url: top.url,
    bvid: top.bvid,
    tabId: null,
    source: 'chromium-history',
    profile: top.profile,
    visitedAt: top.visitedAt,
  }
}

/** Parse the `title, url` shape osascript prints for a list result. */
export function parseAppleScriptResult(stdout) {
  const text = String(stdout ?? '').trim()
  const match = /^([\s\S]*?),\s*(https?:\/\/\S+)$/.exec(text)
  if (!match) return null
  return { title: match[1].trim(), url: match[2].trim() }
}

/** Try AppleScript for the frontmost browser; failures are cached. */
export async function detectAppleScript({ appName, now = Date.now() } = {}) {
  const target = APPLESCRIPT_APPS[String(appName ?? '').trim()]
  if (!target) return null
  const failedAt = appleScriptFailures.get(appName) ?? 0
  if (now - failedAt < 10 * 60 * 1000) return null
  const script =
    target === 'Safari'
      ? 'tell application "Safari" to get {name, URL} of current tab of front window'
      : `tell application "${target}" to get {title, URL} of active tab of front window`
  try {
    const { stdout } = await execFileP('/usr/bin/osascript', ['-e', script], { timeout: 6000 })
    appleScriptFailures.delete(appName)
    return parseAppleScriptResult(stdout)
  } catch {
    appleScriptFailures.set(appName, now)
    return null
  }
}

/** Try AppleScript once for a permission probe; does not cache failures. */
export async function probeAppleScript({ appName, now = Date.now() } = {}) {
  const target = APPLESCRIPT_APPS[String(appName ?? '').trim()]
  if (!target) return { ok: false, error: '当前应用不支持 AppleScript 读取标签页' }
  const script =
    target === 'Safari'
      ? 'tell application "Safari" to get {name, URL} of current tab of front window'
      : `tell application "${target}" to get {title, URL} of active tab of front window`
  try {
    const { stdout } = await execFileP('/usr/bin/osascript', ['-e', script], { timeout: 6000 })
    const result = parseAppleScriptResult(stdout)
    appleScriptFailures.delete(appName)
    if (!result) return { ok: false, error: '浏览器没有返回当前标签页' }
    return { ok: true, ...result }
  } catch (error) {
    return {
      ok: false,
      error: String(error?.stderr ?? error?.message ?? error).trim().slice(0, 300),
      permissionDenied: /permission|not allowed|10004|automation/i.test(String(error?.stderr ?? error?.message ?? '')),
    }
  }
}

/** One-shot user-facing probe of the active tab. */
export async function probeBrowser(config) {
  const front = await frontmostApp({ force: true })
  if (!isBrowserApp(front)) return { ok: false, frontApp: front, reason: 'not-browser' }
  if (isTabbitApp(front)) {
    const tab = await detectTabbit({ task: config.browser.tabbitTask })
    if (!tab) return { ok: false, frontApp: front, reason: 'tabbit-unavailable' }
    return { ok: true, frontApp: front, source: 'tabbit', title: tab.title, url: tab.url }
  }
  if (chromiumVendorFor(front) || front === 'Safari') {
    const result = await probeAppleScript({ appName: front })
    return { ...result, frontApp: front, source: 'applescript' }
  }
  return { ok: false, frontApp: front, reason: 'unsupported-browser' }
}

function normalizeObservation(raw, source) {
  if (!raw) return null
  const title = cleanBrowserTitle(raw.title)
  const url = String(raw.url ?? '')
  if (!url || !isBilibiliVideoUrl(url)) return null
  if (isBilibiliNonVideoPage(url)) return null
  if (title.length < 2) return null
  return {
    source,
    app: raw.app ?? '',
    title,
    url,
    bvid: extractBvid(url) ?? raw.bvid ?? null,
    tabId: raw.tabId ?? null,
    at: Date.now(),
  }
}

/**
 * Detect the current Bilibili video, or return null.
 * @param {object} config resolved config
 * @param {{now?: number, front?: string}} options
 */
export async function detectOnce(config, options = {}) {
  const now = options.now ?? Date.now()
  const front = options.front ?? (await frontmostApp({ now }))
  if (!front || !isBrowserApp(front)) return null
  const backend = config.browser.backend
  const tries = []
  const chromium = chromiumVendorFor(front)
  const appleScript = options.detectAppleScript ?? detectAppleScript
  const detectHistory = options.detectChromium ?? detectChromium

  if (backend === 'tabbit' || (backend === 'auto' && isTabbitApp(front))) {
    tries.push('tabbit')
  }

  // Exact current tab first. Chrome's History is only a fallback: it can
  // easily return the previous video while the user has already switched.
  if (
    backend === 'applescript' ||
    (backend === 'auto' && config.browser.appleScriptEnabled && (chromium || front === 'Safari'))
  ) {
    tries.push('applescript')
  }

  if (backend === 'chromium' || (backend === 'auto' && chromium)) {
    tries.push('chromium')
  }

  for (const kind of tries) {
    if (kind === 'tabbit') {
      const tab = await detectTabbit({ task: config.browser.tabbitTask })
      const observation = normalizeObservation({ ...tab, app: front }, 'tabbit')
      if (observation) return observation
    } else if (kind === 'chromium') {
      const row = await detectHistory({
        appName: front,
        now,
        recencyMinutes: config.browser.chromeRecencyMinutes,
      })
      const observation = normalizeObservation({ ...row, app: front }, 'chromium-history')
      if (observation) return observation
    } else if (kind === 'applescript') {
      const result = await appleScript({ appName: front, now })
      const observation = normalizeObservation({ ...result, app: front }, 'applescript')
      if (observation) return observation
    }
  }
  return null
}

/** Diagnostics for status output / manual debugging. */
export async function browserDiagnostics(config) {
  const front = await frontmostApp({ force: true })
  return {
    platform: process.platform,
    frontApp: front || '（未知）',
    isBrowser: isBrowserApp(front),
    backend: config.browser.backend,
    appleScriptEnabled: config.browser.appleScriptEnabled,
    supportsAppleScript: Boolean(APPLESCRIPT_APPS[front]),
    isChromium: Boolean(chromiumVendorFor(front)),
    isSafari: front === 'Safari',
    tabbitAvailable: existsSync(TABBIT_CLI),
  }
}
