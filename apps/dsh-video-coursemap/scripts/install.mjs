#!/usr/bin/env node
/**
 * Install the enhanced dsh-video-coursemap over the market copy inside the
 * DSH Desktop profile, write its workspace config, and enable
 * dsh-memory-evolve in the user patch layer.
 *
 * This script writes OUTSIDE the session workspace. Run it only after the
 * user approves the profile write. It always creates a backup + rollback
 * script under <workspace>/backups/<timestamp>/.
 *
 * Usage:
 *   node scripts/install.mjs [--profile desktop] [--workspace /abs/path] [--dry-run]
 *   node scripts/install.mjs --rollback <backupDir>
 */

import {
  accessSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const args = process.argv.slice(2)

function arg(name, fallback = null) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  return args[index + 1] ?? fallback
}

const dryRun = args.includes('--dry-run')
const rollbackArg = arg('--rollback')
const profile = arg('--profile', 'desktop')
const workspace = resolve(arg('--workspace', process.cwd()))
const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const target = join(profileDir, 'node_modules', 'dsh-video-coursemap')
const patchPath = join(profileDir, 'cordis.patch.yml')
const packageJsonPath = join(profileDir, 'package.json')

function fail(message) {
  console.error('ERROR:', message)
  process.exit(1)
}

function log(message) {
  console.log((dryRun ? '[dry-run] ' : '') + message)
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  )
}

function rollback(backupDir) {
  const dir = resolve(backupDir)
  const pluginBackup = join(dir, 'plugin')
  const patchBackup = join(dir, 'cordis.patch.yml')
  const packageBackup = join(dir, 'package.json')
  if (!existsSync(pluginBackup) || !existsSync(patchBackup)) {
    fail('备份目录不完整：' + dir)
  }
  if (!dryRun) {
    rmSync(target, { recursive: true, force: true })
    cpSync(pluginBackup, target, { recursive: true })
    copyFileSync(patchBackup, patchPath)
    if (existsSync(packageBackup)) copyFileSync(packageBackup, packageJsonPath)
  }
  log('已回滚 profile 插件与 patch：' + dir)
  log('请退出并重新打开 DeepSeek Harness 使回滚生效。')
}

if (rollbackArg) {
  rollback(rollbackArg)
  process.exit(0)
}

if (!existsSync(profileDir)) fail('找不到 DSH profile：' + profileDir)
if (!existsSync(target)) fail('profile 中未安装 dsh-video-coursemap，请先在 DSH 插件市场安装 2.0.0：' + target)
if (!existsSync(patchPath)) fail('找不到 profile patch：' + patchPath)

for (const relative of [
  'lib/index.js',
  'lib/browser.js',
  'lib/bilibili.js',
  'lib/classify.js',
  'lib/summarize.js',
  'lib/manual.js',
  'lib/state.js',
  'lib/config.js',
  'lib/docx.js',
  'lib/deliver.js',
  'lib/llm.js',
  'lib/util.js',
  'scripts/md2docx.py',
  'cordis.patch.yml',
  'package.json',
]) {
  if (!existsSync(join(packageRoot, relative))) fail('源文件缺失：' + relative)
}

const backupDir = join(workspace, 'backups', `install-${stamp()}`)
const configPath = join(target, 'config.json')
const config = {
  outputDir: join(workspace, '课程知识地图'),
  delivery: { cwd: workspace, newSession: true, present: true, memory: true },
  browser: { backend: 'auto', chromeRecencyMinutes: 30, appleScriptEnabled: true },
  pollIntervalMs: 15000,
  stablePolls: 2,
  rebuildOnStartup: true,
}

function setMemoryEvolveEnabled(text) {
  const lines = String(text ?? '').split('\n')
  let inBlock = false
  let changed = false
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (/^-\s+id:\s*dsh-memory-evolve\s*$/.test(trimmed)) {
      inBlock = true
      continue
    }
    if (inBlock && /^-\s+/.test(trimmed)) {
      inBlock = false
      continue
    }
    if (inBlock && /^disabled:\s*true\s*$/.test(trimmed)) {
      lines[i] = lines[i].replace(/disabled:\s*true/, 'disabled: false')
      changed = true
      inBlock = false
    }
  }
  return { text: lines.join('\n'), changed }
}

function ensureBundle(packageJson, bundle) {
  const next = JSON.parse(JSON.stringify(packageJson))
  next.dsh = next.dsh ?? {}
  next.dsh.profile = next.dsh.profile ?? {}
  next.dsh.profile.bundles = next.dsh.profile.bundles ?? []
  if (!next.dsh.profile.bundles.includes(bundle)) {
    next.dsh.profile.bundles.push(bundle)
    return { json: next, changed: true }
  }
  return { json: next, changed: false }
}

const packageSource = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const packageTarget = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
const bundles = ensureBundle(packageTarget, 'dsh-video-coursemap')
const bundlesMemory = ensureBundle(bundles.json, 'dsh-memory-evolve')

const patchText = readFileSync(patchPath, 'utf8')
const memory = setMemoryEvolveEnabled(patchText)

log('profile: ' + profileDir)
log('workspace: ' + workspace)
log('backup: ' + backupDir)
log('覆盖插件：' + packageSource.name + '@' + packageSource.version)
log('写入 config.json：' + configPath)
log(
  memory.changed
    ? '启用 dsh-memory-evolve（disabled: true → false）'
    : 'dsh-memory-evolve 已启用或不在 user patch 中，无需修改',
)
log(
  bundles.changed || bundlesMemory.changed
    ? '补齐 profile bundles'
    : 'profile bundles 已包含两个插件',
)

if (dryRun) {
  log('dry-run 完成，未写入任何文件。')
  process.exit(0)
}

mkdirSync(backupDir, { recursive: true })
cpSync(target, join(backupDir, 'plugin'), { recursive: true })
copyFileSync(patchPath, join(backupDir, 'cordis.patch.yml'))
copyFileSync(packageJsonPath, join(backupDir, 'package.json'))
writeFileSync(join(backupDir, 'install.json'), JSON.stringify({ profile, workspace, config }, null, 2) + '\n')

for (const dir of ['lib', 'scripts']) {
  rmSync(join(target, dir), { recursive: true, force: true })
  cpSync(join(packageRoot, dir), join(target, dir), { recursive: true })
}
for (const file of ['package.json', 'cordis.patch.yml', 'README.md', 'config.example.json']) {
  if (existsSync(join(packageRoot, file))) {
    copyFileSync(join(packageRoot, file), join(target, file))
  }
}
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')

if (memory.changed) writeFileSync(patchPath, memory.text)
if (bundles.changed || bundlesMemory.changed) {
  writeFileSync(packageJsonPath, JSON.stringify(bundlesMemory.json, null, 2) + '\n')
}

const rollbackScript = [
  '#!/bin/sh',
  'set -e',
  '# 回滚 dsh-video-coursemap + profile patch，然后重启 DeepSeek Harness',
  `rm -rf "${target}"`,
  `cp -R "${join(backupDir, 'plugin')}" "${target}"`,
  `cp "${join(backupDir, 'cordis.patch.yml')}" "${patchPath}"`,
  `cp "${join(backupDir, 'package.json')}" "${packageJsonPath}"`,
  'echo "已回滚。请退出并重新打开 DeepSeek Harness。"',
  '',
].join('\n')
const rollbackPath = join(backupDir, 'rollback.command')
writeFileSync(rollbackPath, rollbackScript)
chmodSync(rollbackPath, 0o755)

// Sanity checks.
for (const relative of ['lib/index.js', 'scripts/md2docx.py', 'config.json']) {
  if (!existsSync(join(target, relative))) fail('安装后校验失败：' + relative)
}
const installedPackage = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
if (installedPackage.name !== 'dsh-video-coursemap') fail('安装后的 package.json name 不正确')
const installedPatch = readFileSync(patchPath, 'utf8')
if (memory.changed && /-\s+id:\s*dsh-memory-evolve[\s\S]*?disabled:\s*true/.test(installedPatch)) {
  fail('dsh-memory-evolve 仍未启用')
}

log('安装完成。')
log('下一步：完全退出并重新打开 DeepSeek Harness（host 插件需要重启加载）。')
log('回滚脚本：' + rollbackPath)
log('重启后请在新会话说“查看课程助手状态”，或直接打开 B 站视频等待 30 秒。')
