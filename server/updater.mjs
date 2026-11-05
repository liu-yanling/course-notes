/**
 * Download, verify and stage a course notes update, then hand off a small
 * shell installer. The installer waits for the current app to exit, replaces
 * the .app bundle, and relaunches it.
 *
 * This is intentionally conservative: it refuses to run outside an .app
 * bundle, requires a SHA-256 in the manifest, and keeps a backup bundle.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { checkForUpdate } from './update.mjs'

function fail(message) {
  const error = new Error(message)
  error.code = 'UPDATE_FAILED'
  throw error
}

function isLocalHttp(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)
  } catch {
    return false
  }
}

function isSafeDownloadUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    return isLocalHttp(url)
  } catch {
    return false
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function downloadAndStageUpdate({
  currentVersion,
  updateUrl,
  dataHome,
  timeoutMs = 120000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const check = await checkForUpdate({ currentVersion, updateUrl, fetchImpl })
  if (!check.ok) fail(check.message || '检查更新失败')
  if (!check.updateAvailable) fail('当前已是最新版本')
  if (!check.sha256) fail('更新清单缺少 sha256，已拒绝安装')
  if (!isSafeDownloadUrl(check.downloadUrl)) fail('更新下载地址必须是 HTTPS（或本机测试地址）')

  const updatesDir = join(dataHome, 'updates')
  const versionDir = join(updatesDir, check.latestVersion)
  const zipPath = join(updatesDir, 'course-notes-' + check.latestVersion + '.zip')
  mkdirSync(updatesDir, { recursive: true })
  rmSync(versionDir, { recursive: true, force: true })
  mkdirSync(versionDir, { recursive: true })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(check.downloadUrl, { signal: controller.signal })
    if (!response.ok) fail('下载更新失败：HTTP ' + response.status)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 1024) fail('下载文件过小，可能不是安装包')
    const actual = sha256(buffer)
    if (actual !== check.sha256.toLowerCase()) fail('更新包 SHA-256 校验失败')
    writeFileSync(zipPath, buffer, { mode: 0o600 })
  } catch (error) {
    if (error.code === 'UPDATE_FAILED') throw error
    fail(error?.name === 'AbortError' ? '下载更新超时' : String(error?.message ?? error))
  } finally {
    clearTimeout(timer)
  }

  const extract = spawnSync('/usr/bin/ditto', ['-x', '-k', zipPath, versionDir], { encoding: 'utf8', timeout: 120000 })
  if (extract.status !== 0) fail('解压更新失败：' + String(extract.stderr ?? '').slice(0, 300))
  const stagedApp = join(versionDir, 'Course Notes.app')
  if (!existsSync(join(stagedApp, 'Contents', 'Info.plist'))) fail('更新包中没有 Course Notes.app')

  return {
    version: check.latestVersion,
    sha256: check.sha256,
    downloadUrl: check.downloadUrl,
    zipPath,
    versionDir,
    stagedApp,
    notes: check.notes,
  }
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

export function writeInstaller({ appPath, stagedApp, version, dataHome }) {
  let currentApp
  try {
    currentApp = realpathSync(appPath)
  } catch {
    fail('当前不是可写的 .app 安装目录，无法自动安装')
  }
  if (!currentApp.endsWith('.app')) fail('当前不是 .app 安装目录，无法自动安装')
  if (!existsSync(join(stagedApp, 'Contents', 'Info.plist'))) fail('暂存的 app 不存在')

  const installDir = join(dataHome, 'updates')
  mkdirSync(installDir, { recursive: true })
  const scriptPath = join(installDir, 'install-' + version + '.sh')
  const logPath = join(installDir, 'install-' + version + '.log')
  const backup = currentApp + '.update-backup'
  const script = `#!/bin/sh
set -u
APP=${shellQuote(currentApp)}
NEW=${shellQuote(stagedApp)}
BACKUP=${shellQuote(backup)}
LOG=${shellQuote(logPath)}
exec >>"$LOG" 2>&1
echo "[$(date)] install ${version}"
for i in $(seq 1 30); do
  if ! pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then break; fi
  sleep 1
done
pkill -f "$APP/Contents/MacOS" >/dev/null 2>&1 || true
sleep 2
rm -rf "$BACKUP"
if ! mv "$APP" "$BACKUP"; then
  echo "backup move failed"
  open "$APP" >/dev/null 2>&1 || true
  exit 1
fi
if ! /usr/bin/ditto "$NEW" "$APP"; then
  echo "copy failed; rolling back"
  rm -rf "$APP"
  mv "$BACKUP" "$APP"
  open "$APP" >/dev/null 2>&1 || true
  exit 1
fi
xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true
chmod +x "$APP/Contents/MacOS/CourseNotes" 2>/dev/null || true
open "$APP" >/dev/null 2>&1 || true
echo "[$(date)] installed ${version}"
`
  writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o700 })
  chmodSync(scriptPath, 0o700)
  return { scriptPath, logPath, currentApp, backup, stagedApp, version }
}

export function startInstaller(installer) {
  const child = spawn('/bin/sh', [installer.scriptPath], { detached: true, stdio: 'ignore' })
  child.unref()
  return { pid: child.pid }
}

export function inspectUpdateFile(zipPath) {
  try {
    const stat = statSync(zipPath)
    return { exists: true, bytes: stat.size }
  } catch {
    return { exists: false, bytes: 0 }
  }
}
