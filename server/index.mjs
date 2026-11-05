#!/usr/bin/env node
/**
 * Standalone course-assistant launcher.
 *
 * Usage:
 *   node server/index.mjs [--port 43110] [--open] [--no-open] [--force]
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createAppServer, VERSION } from './app.mjs'
import { ensureServerDirs, loadConfig, RUNTIME_PATH } from './config.mjs'

const args = process.argv.slice(2)
const has = (name) => args.includes(name)
const valueOf = (name, fallback = null) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] ?? fallback : fallback
}

function openUrl(url) {
  try {
    const child = spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    /* ignore */
  }
}

async function existingServer() {
  if (has('--force')) return null
  try {
    if (!existsSync(RUNTIME_PATH)) return null
    const runtime = JSON.parse(readFileSync(RUNTIME_PATH, 'utf8'))
    if (!runtime?.port) return null
    const res = await fetch(`http://127.0.0.1:${runtime.port}/api/health`, {
      signal: AbortSignal.timeout(1200),
    })
    if (!res.ok) return null
    const health = await res.json()
    if (!health?.ok) return null
    return { ...runtime, health }
  } catch {
    try {
      rmSync(RUNTIME_PATH, { force: true })
    } catch {
      /* ignore */
    }
    return null
  }
}

async function main() {
  ensureServerDirs()
  const existing = await existingServer()
  if (existing) {
    const url = existing.url ?? `http://127.0.0.1:${existing.port}`
    console.log(`course notes 已在运行：${url}`)
    if (!has('--no-open')) openUrl(url)
    return
  }

  const config = loadConfig()
  const portArg = valueOf('--port')
  const port = portArg ? Number(portArg) : config.server.port
  const shouldOpen = !has('--no-open') && (has('--open') || config.autoOpen)
  const app = createAppServer({
    config,
    autoStart: true,
    writeRuntime: true,
    openBrowser: shouldOpen,
  })
  const actualPort = await app.start({ port })
  console.log(`course notes v${VERSION} 已启动：http://127.0.0.1:${actualPort}`)
  if (shouldOpen) console.log('浏览器页面已打开；关闭本进程或页面设置里的“停止服务”即可退出。')

  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal}，正在退出…`)
    try {
      await app.close()
    } catch {
      /* ignore */
    }
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('启动失败：' + String(error?.message ?? error))
  process.exit(1)
})
