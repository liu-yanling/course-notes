/**
 * Login-item management for the menu-bar helper.
 *
 * The helper is installed as a per-user LaunchAgent, so it starts at login
 * without opening a browser. Settings can enable/disable it at any time.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { DATA_HOME, LOG_DIR } from './config.mjs'

const AGENT_LABEL = 'com.coursenotes.menu'
const AGENT_DIR = join(homedir(), 'Library', 'LaunchAgents')
const AGENT_PATH = join(AGENT_DIR, AGENT_LABEL + '.plist')

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function appBundlePath() {
  const explicit = String(process.env.COURSE_NOTES_APP_PATH ?? '').trim()
  if (explicit) return resolve(explicit)
  // In the app bundle, Node runs from Contents/Resources/runtime/node.
  const executable = resolve(process.execPath)
  if (executable.includes('/Contents/Resources/runtime/')) {
    return resolve(dirname(executable), '..', '..', '..')
  }
  return ''
}

export function helperPath() {
  const app = appBundlePath()
  if (!app) return ''
  return join(app, 'Contents', 'MacOS', 'CourseNotesMenu')
}

export function autostartStatus() {
  const helper = helperPath()
  return {
    supported: Boolean(helper) && existsSync(helper),
    enabled: existsSync(AGENT_PATH),
    helperPath: helper,
    agentPath: AGENT_PATH,
    appPath: appBundlePath(),
  }
}

function launchctl(args) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 15000 })
  return { ok: result.status === 0, stderr: String(result.stderr ?? '').trim(), stdout: String(result.stdout ?? '').trim() }
}

export function installAutostart() {
  const status = autostartStatus()
  if (!status.supported) {
    return { ok: false, error: '菜单栏组件未构建，无法安装开机自启', status }
  }
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    mkdirSync(AGENT_DIR, { recursive: true })
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xmlEscape(status.helperPath)}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COURSE_NOTES_DATA_DIR</key><string>${xmlEscape(DATA_HOME)}</string>
    <key>COURSE_NOTES_APP_PATH</key><string>${xmlEscape(status.appPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${xmlEscape(join(LOG_DIR, 'menu.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(LOG_DIR, 'menu.error.log'))}</string>
</dict>
</plist>
`
    writeFileSync(AGENT_PATH, plist, { encoding: 'utf8', mode: 0o644 })
    const uid = String(process.getuid ? process.getuid() : 501)
    launchctl(['bootout', 'gui/' + uid + '/' + AGENT_LABEL])
    const result = launchctl(['bootstrap', 'gui/' + uid, AGENT_PATH])
    if (!result.ok) {
      return { ok: false, error: result.stderr || 'launchctl bootstrap 失败', status: autostartStatus() }
    }
    return { ok: true, status: autostartStatus() }
  } catch (error) {
    const message = error?.code === 'EPERM'
      ? '当前运行环境不允许写入登录项；请从 Finder 启动 app 后重试'
      : String(error?.message ?? error)
    return { ok: false, error: message, status: autostartStatus() }
  }
}

export function removeAutostart() {
  try {
    const uid = String(process.getuid ? process.getuid() : 501)
    launchctl(['bootout', 'gui/' + uid + '/' + AGENT_LABEL])
    rmSync(AGENT_PATH, { force: true })
    return { ok: true, status: autostartStatus() }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), status: autostartStatus() }
  }
}

export function readAutostartPlist() {
  try {
    return existsSync(AGENT_PATH) ? readFileSync(AGENT_PATH, 'utf8') : ''
  } catch {
    return ''
  }
}
