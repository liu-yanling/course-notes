/**
 * macOS .app bundle builder and Desktop shortcut installer.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { APP_ROOT } from './config.mjs'
import { findPython } from '../apps/dsh-video-coursemap/lib/docx.js'

export const APP_BUNDLE_NAME = '课程助手.app'
export const BUILT_APP_PATH = join(APP_ROOT, 'desktop', APP_BUNDLE_NAME)
export const DESKTOP_APP_PATH = join(homedir(), 'Desktop', APP_BUNDLE_NAME)

function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function findNode() {
  const candidates = [
    process.env.COURSE_ASSISTANT_NODE,
    join(homedir(), '.local/share/pi-node/current/bin/node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate.includes('/') && existsSync(candidate)) return candidate
  }
  return 'node'
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildDesktopApp() {
  const app = BUILT_APP_PATH
  const contents = join(app, 'Contents')
  const macos = join(contents, 'MacOS')
  const resources = join(contents, 'Resources')
  for (const dir of [contents, macos, resources]) mkdirSync(dir, { recursive: true })

  const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>课程助手</string>
  <key>CFBundleDisplayName</key><string>课程助手</string>
  <key>CFBundleIdentifier</key><string>local.course-assistant</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>CourseAssistant</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><false/>
</dict>
</plist>
`
  writeFileSync(join(contents, 'Info.plist'), info, 'utf8')

  const node = findNode()
  const executable = `#!/bin/sh
set -e
ROOT=${shQuote(APP_ROOT)}
NODE=${shQuote(node)}
cd "$ROOT"
if [ -f server/runtime.json ]; then
  PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' server/runtime.json | head -1)
  if [ -n "$PORT" ] && curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    open "http://127.0.0.1:$PORT"
    exit 0
  fi
fi
exec "$NODE" server/index.mjs --open
`
  const executablePath = join(macos, 'CourseAssistant')
  writeFileSync(executablePath, executable, 'utf8')
  chmodSync(executablePath, 0o755)

  // Icon is optional: if Pillow/iconutil are unavailable the app still works.
  try {
    const python = findPython()
    if (python) {
      const iconset = join(resources, 'AppIcon.iconset')
      mkdirSync(iconset, { recursive: true })
      const iconResult = spawnSync(python, [join(APP_ROOT, 'scripts', 'make_icon.py'), iconset], {
        timeout: 30000,
        encoding: 'utf8',
      })
      if (iconResult.status === 0) {
        const icns = join(resources, 'AppIcon.icns')
        const icnsResult = spawnSync('/usr/bin/iconutil', ['-c', 'icns', '-o', icns, iconset], {
          timeout: 30000,
          encoding: 'utf8',
        })
        if (icnsResult.status !== 0) {
          console.warn('[course-assistant] iconutil failed:', String(icnsResult.stderr ?? '').slice(0, 200))
        }
      }
    }
  } catch (error) {
    console.warn('[course-assistant] icon skipped:', String(error?.message ?? error))
  }

  try {
    spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], {
      timeout: 30000,
      encoding: 'utf8',
    })
  } catch {
    /* ad-hoc signing is optional */
  }
  return app
}

export function installDesktopShortcut({ targetDir = join(homedir(), 'Desktop'), dryRun = false } = {}) {
  const source = buildDesktopApp()
  const target = join(targetDir, APP_BUNDLE_NAME)
  if (dryRun) return { ok: true, source, target, dryRun: true }
  mkdirSync(targetDir, { recursive: true })
  if (existsSync(target)) {
    const backup = target + '.bak-' + Date.now()
    renameSync(target, backup)
  }
  cpSync(source, target, { recursive: true })
  try {
    chmodSync(join(target, 'Contents', 'MacOS', 'CourseAssistant'), 0o755)
  } catch {
    /* ignore */
  }
  for (const command of [
    ['/usr/bin/xattr', ['-cr', target]],
    ['/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target]],
  ]) {
    try {
      spawnSync(command[0], command[1], { timeout: 30000, encoding: 'utf8' })
    } catch {
      /* optional */
    }
  }
  return { ok: true, source, target }
}

export function desktopShortcutStatus() {
  return {
    built: existsSync(BUILT_APP_PATH),
    installed: existsSync(DESKTOP_APP_PATH),
    builtPath: BUILT_APP_PATH,
    desktopPath: DESKTOP_APP_PATH,
  }
}

export function readInfoPlist() {
  try {
    return readFileSync(join(BUILT_APP_PATH, 'Contents', 'Info.plist'), 'utf8')
  } catch {
    return ''
  }
}
