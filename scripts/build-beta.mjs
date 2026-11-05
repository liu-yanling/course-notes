#!/usr/bin/env node
/**
 * Build an unsigned internal-beta .app + DMG + ZIP.
 *
 * The bundle is self-contained:
 *   Contents/Resources/app      — server/public/engine code
 *   Contents/Resources/runtime  — Node 22
 *   Contents/Resources/python   — Python 3.12 + python-docx
 *
 * No Apple Developer certificate is required for this beta. Testers may need
 * to right-click → Open once (Gatekeeper). The build is ad-hoc signed.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dist = join(root, 'dist')
const buildRoot = join(dist, 'build')
const appPath = join(buildRoot, 'Course Notes.app')
const contents = join(appPath, 'Contents')
const resources = join(contents, 'Resources')
const appCode = join(resources, 'app')
const runtimeDir = join(resources, 'runtime')
const pythonDir = join(resources, 'python')
const version = '1.0.0-beta.1'

function log(message) {
  console.log('[build-beta] ' + message)
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120000,
    ...options,
  })
}

function copyDir(src, dest) {
  if (!existsSync(src)) throw new Error('missing source: ' + src)
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true, force: true })
}

function findNode() {
  const candidates = [
    process.env.COURSE_NOTES_NODE,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    process.execPath,
  ]
  for (const candidate of candidates) {
    if (candidate && candidate.includes('/') && existsSync(candidate)) {
      try {
        const result = run(candidate, ['--version'], { timeoutMs: 10000 })
        if (result.status === 0) return candidate
      } catch {
        /* next */
      }
    }
  }
  throw new Error('找不到可用的 Node 运行时')
}

function findPython() {
  const explicitBinary = String(process.env.COURSE_NOTES_PYTHON || '').trim()
  const candidates = [
    process.env.COURSE_NOTES_PYTHON_ROOT,
    explicitBinary ? dirname(dirname(resolve(explicitBinary))) : '',
    '/opt/homebrew/opt/python@3.12/Frameworks/Python.framework/Versions/3.12',
    '/Library/Frameworks/Python.framework/Versions/3.12',
    '/usr/local/Frameworks/Python.framework/Versions/3.12',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const bin = join(candidate, 'bin', 'python3')
    if (!existsSync(bin)) continue
    const result = run(bin, ['-c', 'import docx; print("ok")'], { timeoutMs: 20000 })
    if (result.status === 0) return candidate
  }
  throw new Error('找不到带 python-docx 的 Python 运行时')
}

function copyCode() {
  copyDir(join(root, 'server'), join(appCode, 'server'))
  copyDir(join(root, 'public'), join(appCode, 'public'))
  copyDir(join(root, 'apps', 'dsh-video-coursemap'), join(appCode, 'apps', 'dsh-video-coursemap'))
  for (const relative of [
    'server/tests',
    'server/logs',
    'server/config.json',
    'server/runtime.json',
    'apps/dsh-video-coursemap/tests',
    'apps/dsh-video-coursemap/fixtures',
    'apps/dsh-video-coursemap/.tmp',
  ]) {
    rmSync(join(appCode, relative), { recursive: true, force: true })
  }
  // Keep only files needed at runtime; tests/readmes are harmless but bulk.
  const engineTests = join(appCode, 'apps/dsh-video-coursemap/tests')
  rmSync(engineTests, { recursive: true, force: true })
}

function writeInfoPlist() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>course notes</string>
  <key>CFBundleDisplayName</key><string>course notes</string>
  <key>CFBundleIdentifier</key><string>com.coursenotes.beta</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>CourseNotes</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><false/>
  <key>NSAppleEventsUsageDescription</key>
  <string>course notes 需要读取当前浏览器标签页，以便识别你正在观看的 B 站课程。</string>
</dict>
</plist>
`
  writeFileSync(join(contents, 'Info.plist'), plist, 'utf8')
}

function writeLauncher(nodePath) {
  const script = `#!/bin/sh
set -e
MACOS="$(cd "$(dirname "$0")" && pwd)"
RES="$(cd "$MACOS/../Resources" && pwd)"
APP_BUNDLE="$(cd "$MACOS/../.." && pwd)"
APP="$RES/app"
NODE="$RES/runtime/node"
export COURSE_NOTES_DATA_DIR="\${COURSE_NOTES_DATA_DIR:-$HOME/Documents/course notes}"
export COURSE_NOTES_PYTHON="$RES/python/bin/python3"
export COURSE_NOTES_APP_PATH="$APP_BUNDLE"
MENU="$MACOS/CourseNotesMenu"
if [ -x "$MENU" ] && ! pgrep -x "CourseNotesMenu" >/dev/null 2>&1; then
  nohup "$MENU" >/dev/null 2>&1 &
fi
cd "$APP"
RUNTIME="$COURSE_NOTES_DATA_DIR/runtime.json"
if [ -f "$RUNTIME" ]; then
  PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$RUNTIME" | head -1)
  if [ -n "$PORT" ] && curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    open "http://127.0.0.1:$PORT"
    exit 0
  fi
fi
exec "$NODE" server/index.mjs --open
`
  const path = join(contents, 'MacOS', 'CourseNotes')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, script, 'utf8')
  chmodSync(path, 0o755)
  // Keep a reference for diagnostics.
  writeFileSync(join(resources, 'runtime-path.txt'), nodePath + '\n', 'utf8')
}

function buildMenuHelper() {
  const source = join(root, 'desktop', 'menu', 'CourseNotesMenu.swift')
  if (!existsSync(source)) {
    console.warn('[build-beta] menu helper source missing:', source)
    return
  }
  const out = join(contents, 'MacOS', 'CourseNotesMenu')
  const result = run('/usr/bin/swiftc', [
    '-O',
    '-swift-version', '5',
    '-framework', 'AppKit',
    '-framework', 'Foundation',
    source,
    '-o', out,
  ], { timeoutMs: 180000 })
  if (result.status !== 0) {
    console.warn('[build-beta] menu helper compile failed:', String(result.stderr ?? '').slice(0, 400))
    return
  }
  chmodSync(out, 0o755)
  log('menu helper compiled')
}

function copyIcon() {
  const candidates = [
    join(root, 'desktop', '课程助手.app', 'Contents', 'Resources', 'AppIcon.icns'),
    join(root, 'desktop', '课程助手.app', 'Contents', 'Resources', 'AppIcon.icns'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cpSync(candidate, join(resources, 'AppIcon.icns'))
      return
    }
  }
}

function signAdHoc() {
  try {
    const result = run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
      timeoutMs: 120000,
    })
    if (result.status !== 0) {
      console.warn('[build-beta] ad-hoc codesign failed:', String(result.stderr ?? '').slice(0, 300))
    }
  } catch (error) {
    console.warn('[build-beta] ad-hoc codesign skipped:', String(error?.message ?? error))
  }
}

function buildDmg() {
  const dmgPath = join(dist, 'course-notes-' + version + '.dmg')
  const staging = join(dist, 'dmg-staging')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  cpSync(appPath, join(staging, 'Course Notes.app'), { recursive: true })
  symlinkSync('/Applications', join(staging, 'Applications'))
  writeFileSync(
    join(staging, '安装说明.txt'),
    [
      'course notes ' + version + ' 内测版',
      '',
      '1. 把 Course Notes.app 拖到 Applications（或直接双击运行）。',
      '2. 如果 macOS 提示“无法验证开发者”：右键 app → 打开 → 仍要打开。',
      '3. 首次启动选择数据目录、填写 DeepSeek Key（或选择本地提取）。',
      '4. 在 Chrome/Safari 打开 B 站课程，保持前台。',
      '',
      '此包未使用 Developer ID 签名/公证，仅供内部测试。',
      '',
    ].join('\n'),
    'utf8',
  )
  let producedDmg = ''
  const result = run(
    '/usr/bin/hdiutil',
    ['create', '-volname', 'course notes', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmgPath],
    { timeoutMs: 300000 },
  )
  if (result.status === 0) {
    producedDmg = dmgPath
  } else {
    console.warn(
      '[build-beta] hdiutil failed (sandbox or host restriction); ZIP will still be produced: ' +
        String(result.stderr ?? result.stdout ?? '').slice(0, 300),
    )
  }
  const zipPath = join(dist, 'course-notes-' + version + '.zip')
  const zipResult = run(
    '/usr/bin/ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', staging, zipPath],
    { timeoutMs: 300000 },
  )
  if (zipResult.status !== 0) {
    console.warn('[build-beta] zip failed:', String(zipResult.stderr ?? '').slice(0, 300))
  }
  return { dmgPath: producedDmg, zipPath }
}

function main() {
  log('root: ' + root)
  rmSync(buildRoot, { recursive: true, force: true })
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  mkdirSync(resources, { recursive: true })

  const node = findNode()
  const python = findPython()
  log('node: ' + node)
  log('python: ' + python)

  copyCode()
  mkdirSync(runtimeDir, { recursive: true })
  cpSync(node, join(runtimeDir, 'node'), { force: true })
  chmodSync(join(runtimeDir, 'node'), 0o755)
  log('node runtime copied')
  copyDir(python, pythonDir)
  log('python runtime copied')
  copyIcon()
  writeInfoPlist()
  writeLauncher(node)
  buildMenuHelper()
  signAdHoc()

  const { dmgPath, zipPath } = buildDmg()
  const appSize = run('/usr/bin/du', ['-sh', appPath], { timeoutMs: 30000 }).stdout.trim()
  log('app: ' + appPath + ' (' + appSize + ')')
  if (dmgPath) {
    const dmgSize = run('/usr/bin/du', ['-sh', dmgPath], { timeoutMs: 30000 }).stdout.trim()
    log('dmg: ' + dmgPath + ' (' + dmgSize + ')')
  } else {
    log('dmg: skipped (sandbox/hdiutil); use ZIP')
  }
  log('zip: ' + zipPath)
  log('done. 未签名/未公证，仅供内部测试。')
}

main()
