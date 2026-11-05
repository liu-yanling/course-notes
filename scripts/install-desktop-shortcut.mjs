#!/usr/bin/env node
/**
 * Build the macOS app bundle and copy it to ~/Desktop.
 * Run from a normal Terminal if the agent sandbox cannot write Desktop.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installDesktopShortcut, desktopShortcutStatus } from '../server/shortcut.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const json = args.includes('--json')
const targetIndex = args.indexOf('--target')
const targetDir = targetIndex >= 0 ? args[targetIndex + 1] : join(homedir(), 'Desktop')

try {
  const result = installDesktopShortcut({ targetDir, dryRun })
  if (json) {
    console.log(JSON.stringify(result))
  } else {
    console.log(dryRun ? '预览（未写入）：' : '已创建桌面快捷方式：')
    console.log('  ' + result.target)
    console.log('  源：' + result.source)
    if (!dryRun) console.log('提示：双击「课程助手.app」即可启动，不需要打开 DeepSeek Harness。')
  }
} catch (error) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
  } else {
    console.error('创建桌面快捷方式失败：' + String(error?.message ?? error))
    console.error('请双击工作区里的「创建桌面快捷方式.command」，它会以你的终端权限重试。')
  }
  process.exit(1)
}
