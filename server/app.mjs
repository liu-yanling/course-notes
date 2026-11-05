/**
 * Standalone course-assistant HTTP server, polling loop and SSE feed.
 */
import http from 'node:http'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, basename } from 'node:path'
import { spawn } from 'node:child_process'

import {
  LOG_PATH,
  PUBLIC_DIR,
  RUNTIME_PATH,
  configPaths,
  engineConfig,
  loadConfig,
  normalizeConfig,
  patchConfig,
  publicConfig,
  saveConfig,
} from './config.mjs'
import { createEventHub } from './events.mjs'
import { createPipeline } from './pipeline.mjs'
import { buildHistory, getVideoDetail } from './history.mjs'
import {
  browserDiagnostics,
  detectOnce,
  frontmostApp,
  isBrowserApp,
  probeBrowser,
} from '../apps/dsh-video-coursemap/lib/browser.js'
import {
  ensureLayout,
  isSeen,
  loadState,
  saveState,
} from '../apps/dsh-video-coursemap/lib/state.js'
import { normalizeTitle } from '../apps/dsh-video-coursemap/lib/util.js'
import { assertRealInside, isFile, resolveOutputPath } from './path-guard.mjs'
import { keyStatus, listOllamaModels, testLlm } from './llm.mjs'
import { deleteKeychainKey, setKeychainKey } from './keychain.mjs'
import { notifyComplete } from './notify.mjs'
import { checkForUpdate } from './update.mjs'
import { clearRetry, readRetry, retryDelay, writeRetry, MAX_RETRY_ATTEMPTS } from './retry.mjs'
import { autostartStatus, installAutostart, removeAutostart } from './autostart.mjs'
import { desktopShortcutStatus, installDesktopShortcut } from './shortcut.mjs'

export const VERSION = String(process.env.COURSE_NOTES_VERSION || '1.0.0').trim()
const PORTS = [43110, 43111, 43112, 43113, 43114, 43115, 43116, 43117, 43118, 43119]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function errorJson(res, status, message, code = 'ERROR') {
  json(res, status, { ok: false, code, message })
}

async function readJsonBody(req, limit = 1024 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('请求体过大')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.code = 'BAD_JSON'
    throw error
  }
}

function safeFileName(path) {
  return basename(path)
}

function openPath(path, reveal = false) {
  const args = reveal ? ['-R', path] : [path]
  const child = spawn('/usr/bin/open', args, { detached: true, stdio: 'ignore' })
  child.unref()
}

function formatLog(event) {
  return JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'
}

export function createAppServer(options = {}) {
  let config = normalizeConfig(options.config ?? loadConfig())
  let paths = configPaths(config)
  ensureLayout(paths)
  let state = loadState(paths.statePath)
  let engine = engineConfig(config)
  let pipeline = options.pipeline ?? null
  let timer = null
  let nextPollAt = 0
  let pending = null
  let busy = false
  let currentTask = null
  let currentObservation = null
  let frontApp = ''
  let lastError = ''
  let lastPoll = null
  let retry = readRetry(join(paths.stateDir, 'retry.json'))
  let retryTimer = null
  let actualPort = 0
  let httpServer = null
  let shuttingDown = false
  let ollamaCache = { at: 0, models: [] }
  const startedAt = Date.now()
  const hub = createEventHub({ maxPolls: 80, maxLogs: 160 })
  const autoStart = options.autoStart !== false
  const writeRuntime = options.writeRuntime !== false
  const openBrowser = Boolean(options.openBrowser)

  function appendLogLine(event) {
    try {
      mkdirSync(join(paths.stateDir, 'logs'), { recursive: true })
      const line = formatLog(event)
      appendFileSync(LOG_PATH, line, 'utf8')
      try {
        if (statSync(LOG_PATH).size > 2 * 1024 * 1024) {
          rmSync(LOG_PATH + '.1', { force: true })
          // Keep a single rotated copy.
          renameSync(LOG_PATH, LOG_PATH + '.1')
        }
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }

  function log(level, message, extra = {}) {
    const event = { type: 'log', level, message: String(message ?? ''), at: Date.now(), ...extra }
    appendLogLine(event)
    hub.broadcast(event)
    return event
  }

  if (!pipeline) {
    pipeline = createPipeline({
      config,
      engine,
      state,
      paths,
      emit,
      save: saveState,
    })
  }

  function emit(event) {
    if (!event || typeof event !== 'object') return
    if (event.type === 'task') {
      currentTask = {
        taskId: event.taskId,
        stage: event.stage,
        progress: event.progress,
        title: event.title,
        message: event.message,
        startedAt: currentTask?.taskId === event.taskId ? currentTask.startedAt : Date.now(),
        at: event.at ?? Date.now(),
        skipped: event.skipped,
      }
      if (event.stage === 'error') lastError = event.message ?? '任务失败'
    } else if (event.type === 'summary:done') {
      currentTask = {
        ...(currentTask ?? {}),
        stage: 'done',
        progress: 100,
        title: event.title ?? currentTask?.title,
        message: '知识总结完成',
        finishedAt: Date.now(),
      }
    } else if (event.type === 'error') {
      lastError = event.message ?? lastError
    } else if (event.type === 'log') {
      appendLogLine(event)
    }
    hub.broadcast(event)
    if (event.type === 'summary:done' && config.notifyOnComplete) notifyComplete(event)
    if (event.type === 'task' || event.type === 'summary:done') broadcastStatus()
  }

  function statusSnapshot() {
    return {
      ok: true,
      version: VERSION,
      pid: process.pid,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      enabled: Boolean(config.enabled),
      running: Boolean(timer),
      busy,
      nextPollAt,
      pollIntervalMs: config.pollIntervalMs,
      stablePolls: config.stablePolls,
      backend: config.backend,
      frontApp: frontApp || '',
      current: currentObservation,
      task: currentTask,
      lastPoll,
      lastError,
      retry: retry ? {
        title: retry.observation?.title ?? '',
        attempts: retry.attempts,
        nextAt: retry.nextAt,
        error: retry.error,
        maxAttempts: MAX_RETRY_ATTEMPTS,
      } : null,
      outputDir: config.outputDir,
      port: actualPort || config.server.port,
      subjects: Object.keys(state.subjects ?? {}).length,
      videos: Object.keys(state.videos ?? {}).length,
      llm: keyStatus(config),
      config: publicConfig(config),
      desktop: desktopShortcutStatus(),
    }
  }

  function broadcastStatus() {
    const snapshot = statusSnapshot()
    hub.setStatus(snapshot)
    hub.broadcast({ type: 'status', ...snapshot })
    return snapshot
  }

  function broadcastConfig() {
    hub.broadcast({ type: 'config', config: publicConfig(config), at: Date.now() })
  }

  function scheduleNext(delay = config.pollIntervalMs) {
    if (timer) clearTimeout(timer)
    timer = null
    if (!config.enabled) {
      nextPollAt = 0
      return
    }
    nextPollAt = Date.now() + Math.max(0, Number(delay) || config.pollIntervalMs)
    timer = setTimeout(() => {
      timer = null
      pollOnce().catch((error) => {
        lastError = String(error?.message ?? error)
        emit({ type: 'error', scope: 'poll', message: lastError, at: Date.now() })
        scheduleNext()
      })
    }, Math.max(0, Number(delay) || config.pollIntervalMs))
    timer.unref?.()
    broadcastStatus()
  }

  async function pollOnce({ manual = false } = {}) {
    if (!manual && !config.enabled) return { ok: false, skipped: 'disabled' }
    if (busy) {
      lastPoll = { at: Date.now(), decision: 'busy', message: '上一任务仍在运行' }
      emit({ type: 'poll', ...lastPoll })
      scheduleNext()
      return { ok: false, skipped: 'busy' }
    }
    const startedAtPoll = Date.now()
    let observation = null
    try {
      observation = await detectOnce(engine)
    } catch (error) {
      lastError = String(error?.message ?? error)
      lastPoll = { at: Date.now(), decision: 'error', message: lastError, durationMs: Date.now() - startedAtPoll }
      emit({ type: 'poll', ...lastPoll })
      emit({ type: 'error', scope: 'detect', message: lastError, at: Date.now() })
      scheduleNext()
      return { ok: false, skipped: 'error' }
    }

    if (!observation) {
      frontApp = await frontmostApp().catch(() => frontApp)
      const decision = isBrowserApp(frontApp) ? 'no-video' : 'no-browser'
      lastPoll = {
        at: Date.now(),
        decision,
        app: frontApp,
        message: decision === 'no-browser' ? '当前前台不是浏览器' : '浏览器中没有识别到 B 站视频',
        durationMs: Date.now() - startedAtPoll,
      }
      emit({ type: 'poll', ...lastPoll })
      scheduleNext()
      return { ok: true, skipped: decision }
    }

    currentObservation = observation
    frontApp = observation.app || frontApp
    if (isSeen(state, observation)) {
      pending = null
      lastPoll = {
        at: Date.now(),
        decision: 'seen',
        source: observation.source,
        app: observation.app,
        title: observation.title,
        url: observation.url,
        bvid: observation.bvid,
        message: '已处理过，保持静默',
        durationMs: Date.now() - startedAtPoll,
      }
      emit({ type: 'poll', ...lastPoll })
      scheduleNext()
      return { ok: true, skipped: 'seen' }
    }

    const key = observation.bvid || normalizeTitle(observation.title)
    if (!pending || pending.key !== key) pending = { key, observation, count: 1 }
    else pending.count += 1

    if (pending.count < config.stablePolls) {
      lastPoll = {
        at: Date.now(),
        decision: 'stable-wait',
        source: observation.source,
        app: observation.app,
        title: observation.title,
        url: observation.url,
        bvid: observation.bvid,
        message: '等待稳定确认 ' + pending.count + '/' + config.stablePolls,
        durationMs: Date.now() - startedAtPoll,
      }
      emit({ type: 'poll', ...lastPoll })
      scheduleNext()
      return { ok: true, skipped: 'stable-wait' }
    }

    const ready = pending.observation
    pending = null
    lastPoll = {
      at: Date.now(),
      decision: 'new',
      source: ready.source,
      app: ready.app,
      title: ready.title,
      url: ready.url,
      bvid: ready.bvid,
      message: '发现新视频，开始总结',
      durationMs: Date.now() - startedAtPoll,
    }
    emit({ type: 'poll', ...lastPoll })
    await runTask(ready, { force: false })
    scheduleNext()
    return { ok: true, task: true }
  }

  function retryPath() {
    return join(paths.stateDir, 'retry.json')
  }

  function clearRetryState({ notify = true } = {}) {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    retry = null
    clearRetry(retryPath())
    if (notify) broadcastStatus()
  }

  function armRetryTimer(delay) {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    if (!retry) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      runRetry().catch((error) => {
        lastError = String(error?.message ?? error)
        emit({ type: 'error', scope: 'retry', message: lastError, at: Date.now() })
      })
    }, Math.max(0, Number(delay) || 0))
    retryTimer.unref?.()
  }

  function scheduleRetry(observation, error) {
    if (shuttingDown) return
    const attempts = (retry?.attempts ?? 0) + 1
    if (attempts > MAX_RETRY_ATTEMPTS) {
      const message = '自动重试已达上限：' + String(error ?? '任务失败')
      clearRetryState({ notify: false })
      lastError = message
      emit({ type: 'retry', state: 'exhausted', attempts, message, at: Date.now() })
      broadcastStatus()
      return
    }
    const nextAt = Date.now() + retryDelay(attempts)
    retry = {
      observation,
      attempts,
      nextAt,
      error: String(error ?? '任务失败'),
      at: Date.now(),
    }
    writeRetry(retryPath(), retry)
    emit({
      type: 'retry',
      state: 'scheduled',
      attempts,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      nextAt,
      title: observation.title,
      message: '任务失败，将在 ' + Math.round(retryDelay(attempts) / 1000) + ' 秒后重试',
      at: Date.now(),
    })
    armRetryTimer(nextAt - Date.now())
    broadcastStatus()
  }

  async function runRetry() {
    if (!retry || shuttingDown) return
    if (busy) {
      armRetryTimer(5000)
      return
    }
    const observation = retry.observation
    try {
      await runTask(observation, { force: true, retry: true })
    } catch (error) {
      lastError = String(error?.message ?? error)
    }
  }

  async function runTask(observation, opts = {}) {
    if (busy) {
      const error = new Error('已有任务正在运行')
      error.code = 'BUSY'
      throw error
    }
    busy = true
    currentTask = {
      taskId: '',
      stage: 'detect',
      progress: 2,
      title: observation.title,
      message: '准备处理视频…',
      startedAt: Date.now(),
    }
    broadcastStatus()
    try {
      const result = await pipeline.runTask(observation, opts)
      if (result && result.ok === false) {
        lastError = result.error || '任务失败'
        scheduleRetry(observation, lastError)
      } else if (result && result.docxError) {
        lastError = result.docxError
        scheduleRetry(observation, 'Word 生成失败：' + result.docxError)
      } else {
        lastError = ''
        if (retry) clearRetryState({ notify: false })
      }
      return result
    } catch (error) {
      lastError = String(error?.message ?? error)
      scheduleRetry(observation, lastError)
      throw error
    } finally {
      busy = false
      broadcastStatus()
    }
  }

  function startPolling() {
    if (!config.enabled) return
    scheduleNext(0)
    if (retry) armRetryTimer(Math.max(0, retry.nextAt - Date.now()))
  }

  function stopPolling() {
    if (timer) clearTimeout(timer)
    timer = null
    nextPollAt = 0
    pending = null
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    try {
      pipeline.abort?.()
    } catch {
      /* ignore */
    }
    broadcastStatus()
  }

  function freshPipeline() {
    try {
      pipeline.abort?.()
    } catch {
      /* ignore */
    }
    pipeline = createPipeline({ config, engine, state, paths, emit, save: saveState })
  }

  function applyConfig(input = {}) {
    const previousOutput = config.outputDir
    const next = saveConfig(patchConfig(config, input))
    config = next
    const outputChanged = previousOutput !== config.outputDir
    if (outputChanged) {
      clearRetryState({ notify: false })
      paths = configPaths(config)
      ensureLayout(paths)
      state = loadState(paths.statePath)
      retry = readRetry(retryPath())
    }
    engine = engineConfig(config)
    if (!busy && !options.pipeline) freshPipeline()
    broadcastConfig()
    if (config.enabled) scheduleNext(0)
    else stopPolling()
    const snapshot = broadcastStatus()
    return snapshot
  }

  function setFrontApp(name) {
    if (typeof name === 'string' && name) frontApp = name
  }

  async function handleApi(req, res, url) {
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, { ok: true, version: VERSION, pid: process.pid, port: actualPort || config.server.port, uptimeMs: Date.now() - startedAt })
    }
    if (req.method === 'GET' && path === '/api/status') {
      setFrontApp(await frontmostApp().catch(() => frontApp))
      return json(res, 200, statusSnapshot())
    }
    if (req.method === 'GET' && path === '/api/history') {
      return json(res, 200, { ok: true, ...buildHistory(config), desktop: desktopShortcutStatus() })
    }
    if (req.method === 'GET' && path === '/api/video') {
      const detail = getVideoDetail(config, { key: url.searchParams.get('key') ?? '', bvid: url.searchParams.get('bvid') ?? '' })
      if (!detail) return errorJson(res, 404, '没有找到该视频', 'NOT_FOUND')
      return json(res, 200, { ok: true, video: detail })
    }
    if (req.method === 'GET' && path === '/api/logs') {
      return json(res, 200, { ok: true, logs: hub.getLogs() })
    }
    if (req.method === 'GET' && path === '/api/retry') {
      return json(res, 200, { ok: true, retry: statusSnapshot().retry })
    }
    if (req.method === 'POST' && path === '/api/retry') {
      const body = await readJsonBody(req)
      const action = String(body.action ?? 'now')
      if (action === 'clear') {
        clearRetryState()
        return json(res, 200, { ok: true, retry: null })
      }
      if (action !== 'now') return errorJson(res, 400, '未知 retry action', 'BAD_ACTION')
      if (!retry) return errorJson(res, 400, '没有待重试任务', 'NO_RETRY')
      if (busy) return errorJson(res, 409, '已有任务正在运行', 'BUSY')
      const observation = retry.observation
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      runRetry().catch((error) => {
        lastError = String(error?.message ?? error)
        emit({ type: 'error', scope: 'retry', message: lastError, at: Date.now() })
      })
      return json(res, 200, { ok: true, retry: statusSnapshot().retry, title: observation.title })
    }
    if (req.method === 'GET' && path === '/api/browser') {
      const diagnostics = await browserDiagnostics(engine)
      return json(res, 200, {
        ok: true,
        ...diagnostics,
        lastSource: currentObservation?.source ?? null,
        lastTitle: currentObservation?.title ?? '',
      })
    }
    if (req.method === 'POST' && path === '/api/browser/probe') {
      const result = await probeBrowser(engine)
      return json(res, 200, { ok: result.ok, ...result })
    }
    if (req.method === 'GET' && path === '/api/autostart') {
      return json(res, 200, { ok: true, autostart: autostartStatus() })
    }
    if (req.method === 'POST' && path === '/api/autostart') {
      const body = await readJsonBody(req)
      const result = body.enabled ? installAutostart() : removeAutostart()
      return json(res, result.ok ? 200 : 500, { ok: result.ok, error: result.error, autostart: result.status })
    }
    if (req.method === 'GET' && path === '/api/update') {
      const result = await checkForUpdate({ currentVersion: VERSION, updateUrl: config.updateUrl })
      return json(res, 200, { ok: result.ok, ...result })
    }
    if (req.method === 'GET' && path === '/api/llm') {
      if (Date.now() - ollamaCache.at > 5000) {
        ollamaCache = { at: Date.now(), models: await listOllamaModels() }
      }
      return json(res, 200, {
        ok: true,
        ...keyStatus(config),
        ollamaModels: ollamaCache.models,
        desktop: desktopShortcutStatus(),
      })
    }
    if (req.method === 'POST' && path === '/api/config') {
      const body = await readJsonBody(req)
      const status = applyConfig(body)
      return json(res, 200, { ok: true, config: publicConfig(config), status })
    }
    if (req.method === 'POST' && path === '/api/llm/key') {
      const body = await readJsonBody(req)
      const action = String(body.action ?? 'save')
      if (action === 'delete') {
        const result = deleteKeychainKey()
        return json(res, 200, { ok: result.ok, deleted: Boolean(result.deleted), llm: keyStatus(config) })
      }
      const key = String(body.key ?? '').trim()
      if (!key) return errorJson(res, 400, '缺少 Key', 'BAD_INPUT')
      const result = setKeychainKey(key)
      if (!result.ok) return errorJson(res, 500, result.error || 'Keychain 写入失败', 'KEYCHAIN_FAILED')
      return json(res, 200, { ok: true, llm: keyStatus(config) })
    }
    if (req.method === 'POST' && path === '/api/open-url') {
      const body = await readJsonBody(req)
      const target = String(body.url ?? '').trim()
      const allowed = target.startsWith('x-apple.systempreferences:') || target.startsWith('https://')
      if (!allowed) return errorJson(res, 400, '不允许打开该 URL', 'INVALID_URL')
      try {
        const child = spawn('/usr/bin/open', [target], { detached: true, stdio: 'ignore' })
        child.unref()
        return json(res, 200, { ok: true })
      } catch (error) {
        return errorJson(res, 500, String(error?.message ?? error), 'OPEN_FAILED')
      }
    }
    if (req.method === 'POST' && path === '/api/llm/test') {
      return json(res, 200, { ok: true, result: await testLlm(config) })
    }
    if (req.method === 'POST' && path === '/api/shortcut') {
      try {
        const result = installDesktopShortcut()
        return json(res, 200, { ok: true, ...result, status: desktopShortcutStatus() })
      } catch (error) {
        return errorJson(res, 500, String(error?.message ?? error), 'SHORTCUT_FAILED')
      }
    }
    if (req.method === 'POST' && path === '/api/open') {
      const body = await readJsonBody(req)
      try {
        const target = assertRealInside(config.outputDir, resolveOutputPath(config.outputDir, body.path))
        openPath(target, Boolean(body.reveal))
        return json(res, 200, { ok: true, path: target })
      } catch (error) {
        return errorJson(res, 400, String(error?.message ?? error), 'INVALID_PATH')
      }
    }
    if (req.method === 'POST' && path === '/api/control') {
      const body = await readJsonBody(req)
      const action = String(body.action ?? '')
      if (action === 'start') {
        applyConfig({ enabled: true })
        return json(res, 200, { ok: true, status: statusSnapshot() })
      }
      if (action === 'stop') {
        applyConfig({ enabled: false })
        return json(res, 200, { ok: true, status: statusSnapshot() })
      }
      if (action === 'pollNow') {
        if (busy) return errorJson(res, 409, '已有任务正在运行', 'BUSY')
        if (timer) clearTimeout(timer)
        timer = null
        const promise = pollOnce({ manual: true })
        promise.catch((error) => log('error', String(error?.message ?? error)))
        return json(res, 200, { ok: true, status: statusSnapshot() })
      }
      if (action === 'scan') {
        if (busy) return errorJson(res, 409, '已有任务正在运行', 'BUSY')
        const title = String(body.title ?? '').trim()
        const url = String(body.url ?? '').trim()
        let bvid = body.bvid ? String(body.bvid).trim() : undefined
        if (!bvid && url) {
          const match = /(BV[0-9A-Za-z]{10})/.exec(url)
          if (match) bvid = match[1]
        }
        if (!title && !url && !bvid) return errorJson(res, 400, '需要 title 或 url', 'BAD_INPUT')
        const observation = { source: 'manual', title, url, bvid, at: Date.now() }
        emit({ type: 'poll', at: Date.now(), decision: 'manual', source: 'manual', title, url, bvid, message: '手动总结' })
        runTask(observation, { force: Boolean(body.force), manual: true })
          .catch((error) => {
            lastError = String(error?.message ?? error)
            emit({ type: 'error', scope: 'manual', message: lastError, at: Date.now() })
          })
          .finally(() => {
            if (config.enabled) scheduleNext()
          })
        return json(res, 200, { ok: true, status: statusSnapshot() })
      }
      if (action === 'shutdown') {
        json(res, 200, { ok: true, message: '服务正在退出' })
        setTimeout(() => close(), 120)
        return
      }
      return errorJson(res, 400, '未知 action', 'BAD_ACTION')
    }
    if (req.method === 'GET' && path === '/api/doc') {
      try {
        const target = assertRealInside(config.outputDir, resolveOutputPath(config.outputDir, url.searchParams.get('path') ?? ''))
        if (!isFile(target) || !['.docx', '.md'].includes(extname(target).toLowerCase())) {
          return errorJson(res, 404, '文件不存在', 'NOT_FOUND')
        }
        res.writeHead(200, {
          'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(target))}`,
          'Cache-Control': 'no-store',
        })
        createReadStream(target).pipe(res)
        return
      } catch (error) {
        return errorJson(res, 400, String(error?.message ?? error), 'INVALID_PATH')
      }
    }
    return errorJson(res, 404, 'Not found', 'NOT_FOUND')
  }

  function hostAllowed(req) {
    const host = String(req.headers.host ?? '')
    return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
  }

  function originAllowed(req) {
    const origin = String(req.headers.origin ?? '')
    if (!origin) return true
    const host = String(req.headers.host ?? '')
    return origin === 'http://' + host || origin === 'https://' + host
  }

  async function handle(req, res) {
    try {
      if (!hostAllowed(req)) return errorJson(res, 403, '仅允许本机访问', 'FORBIDDEN')
      if (!originAllowed(req)) return errorJson(res, 403, '跨站请求已拒绝', 'CSRF')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/api/events') {
        return hub.subscribe(req, res)
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url)
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return errorJson(res, 405, 'Method not allowed', 'METHOD')
      }
      const fileMap = {
        '/': 'index.html',
        '/index.html': 'index.html',
        '/styles.css': 'styles.css',
        '/app.js': 'app.js',
      }
      const relative = fileMap[url.pathname]
      if (!relative) return errorJson(res, 404, 'Not found', 'NOT_FOUND')
      const file = join(PUBLIC_DIR, relative)
      if (!existsSync(file)) return errorJson(res, 404, '页面资源缺失', 'NOT_FOUND')
      const body = readFileSync(file)
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
      })
      if (req.method === 'HEAD') res.end()
      else res.end(body)
    } catch (error) {
      log('error', String(error?.message ?? error))
      if (!res.headersSent) errorJson(res, 500, String(error?.message ?? error), 'SERVER_ERROR')
      else res.end()
    }
  }

  async function listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          if (!res.headersSent) errorJson(res, 500, String(error?.message ?? error), 'SERVER_ERROR')
          else res.end()
        })
      })
      server.once('error', (error) => {
        server.close(() => reject(error))
      })
      server.listen(port, '127.0.0.1', () => {
        resolve(server)
      })
    })
  }

  async function start({ port = config.server.port } = {}) {
    if (httpServer) return actualPort
    const candidates = port === 0 ? [0] : [port, ...PORTS.filter((value) => value !== port)]
    let lastError = null
    for (const candidate of candidates) {
      try {
        httpServer = await listen(candidate)
        actualPort = httpServer.address().port
        break
      } catch (error) {
        lastError = error
        if (candidate === 0) throw error
      }
    }
    if (!httpServer) throw lastError ?? new Error('无法监听端口')
    if (writeRuntime) {
      writeFileSync(
        RUNTIME_PATH,
        JSON.stringify(
          { pid: process.pid, port: actualPort, host: '127.0.0.1', url: `http://127.0.0.1:${actualPort}`, startedAt, version: VERSION },
          null,
          2,
        ) + '\n',
      )
    }
    log('info', `course notes 独立版已启动：http://127.0.0.1:${actualPort}`)
    if (openBrowser) {
      const url = `http://127.0.0.1:${actualPort}`
      const child = spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' })
      child.unref()
    }
    if (autoStart && config.enabled) startPolling()
    broadcastStatus()
    return actualPort
  }

  async function close() {
    if (shuttingDown) return
    shuttingDown = true
    if (timer) clearTimeout(timer)
    timer = null
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    try {
      pipeline.abort?.()
    } catch {
      /* ignore */
    }
    hub.closeAll()
    try {
      if (writeRuntime) rmSync(RUNTIME_PATH, { force: true })
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      if (!httpServer) return resolve()
      httpServer.close(() => resolve())
      setTimeout(resolve, 1500).unref?.()
    })
    httpServer = null
  }

  return {
    start,
    close,
    hub,
    get config() {
      return config
    },
    get paths() {
      return paths
    },
    get state() {
      return state
    },
    get port() {
      return actualPort
    },
    status: statusSnapshot,
    applyConfig,
    pollOnce,
    runTask,
    startPolling,
    stopPolling,
  }
}
