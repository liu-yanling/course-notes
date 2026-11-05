/**
 * Public, stateless course notes web MVP.
 *
 * Deliberately separate from the local app server: no filesystem notes, no
 * browser detection, no Keychain, no local control API. The only persistence
 * is an in-memory rate-limit counter.
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { coverageText, fetchVideoContent } from '../apps/dsh-video-coursemap/lib/bilibili.js'
import { classify, fallbackClassify } from '../apps/dsh-video-coursemap/lib/classify.js'
import { generateSummary } from '../apps/dsh-video-coursemap/lib/summarize.js'
import { buildLocalSummary } from '../server/local-summary.mjs'
import { extractBvid, sanitizeSubject, uniqueStrings } from '../apps/dsh-video-coursemap/lib/util.js'
import { createWebContext, hasKey } from './llm.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(here, 'public')
const MD2DOCX = join(here, '..', 'apps', 'dsh-video-coursemap', 'scripts', 'md2docx.py')
const PORT = Number(process.env.PORT || 10000)
const MAX_BODY = 128 * 1024
const MAX_SUMMARY_BODY = 512 * 1024
const RATE_LIMIT = Number(process.env.WEB_RATE_LIMIT || 8)
const RATE_WINDOW_MS = 10 * 60 * 1000
const buckets = new Map()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const engine = {
  provider: 'deepseek',
  model: String(process.env.DEEPSEEK_MODEL || 'deepseek-chat'),
  maxTokens: 4096,
  fetchContent: true,
  titleMinLen: 4,
  summary: { maxDanmaku: 120, maxComments: 20, maxDescChars: 1200 },
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  return forwarded || req.socket.remoteAddress || 'unknown'
}

function rateAllowed(ip) {
  const now = Date.now()
  const bucket = buckets.get(ip) || []
  const recent = bucket.filter((at) => now - at < RATE_WINDOW_MS)
  if (recent.length >= RATE_LIMIT) {
    buckets.set(ip, recent)
    return false
  }
  recent.push(now)
  buckets.set(ip, recent)
  if (buckets.size > 5000) {
    for (const [key, value] of buckets) {
      if (!value.some((at) => now - at < RATE_WINDOW_MS)) buckets.delete(key)
    }
  }
  return true
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

async function readJson(req, limit = MAX_BODY) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('请求体过大')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('请求体不是 JSON')
    error.statusCode = 400
    throw error
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('处理超时，请稍后重试')), ms)),
  ])
}

async function summarize({ bvid, apiKey }) {
  const content = await fetchVideoContent({ bvid }, engine)
  const title = String(content?.title || bvid).trim()
  let context = null
  let classification = null
  let warning = ''
  if (hasKey(apiKey)) {
    context = createWebContext(apiKey)
    try {
      classification = await classify(context, engine, { title, existingSubjects: {} })
    } catch (error) {
      warning = 'LLM 分类失败，已使用关键词分类：' + String(error?.message ?? error).slice(0, 120)
    }
  }
  if (!classification) classification = fallbackClassify(title, {})
  const subject = sanitizeSubject(classification.subject)
  const keywords = uniqueStrings([...(classification.keywords ?? []), ...(content?.tags ?? [])], 10)
  let mode = 'local'
  let markdown = ''
  if (context) {
    try {
      markdown = await generateSummary(context, engine, { title, subject, keywords, content })
      if (markdown && !markdown.includes('本次 LLM 总结失败')) mode = 'llm'
    } catch (error) {
      warning = 'LLM 总结失败，已降级为本地提取：' + String(error?.message ?? error).slice(0, 120)
    }
  }
  if (!markdown || markdown.includes('本次 LLM 总结失败')) {
    markdown = buildLocalSummary({ title, subject, keywords, content })
    mode = 'local'
  }
  return {
    bvid: content?.bvid || bvid,
    title,
    subject,
    keywords,
    markdown,
    mode,
    warning,
    coverage: coverageText(content),
    hasContent: Boolean(content),
  }
}

function safeFileName(title) {
  return (String(title || 'course-notes').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || 'course-notes') + '.docx'
}

async function makeDocx(markdown, title) {
  const dir = mkdtempSync(join('/tmp', 'course-notes-web-'))
  const input = join(dir, 'note.md')
  const output = join(dir, 'note.docx')
  try {
    writeFileSync(input, markdown, 'utf8')
    const python = process.env.COURSE_NOTES_PYTHON || 'python3'
    const child = spawn(python, [MD2DOCX, input, output], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const status = await new Promise((resolve) => child.on('close', resolve))
    if (status !== 0) throw new Error('Word 生成失败：' + stderr.slice(0, 200))
    return { buffer: readFileSync(output), filename: safeFileName(title) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function serveStatic(req, res, pathname) {
  const map = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' }
  const name = map[pathname]
  if (!name) return false
  try {
    const body = readFileSync(join(PUBLIC_DIR, name))
    res.writeHead(200, {
      'Content-Type': MIME[extname(name)] || 'application/octet-stream',
      'Cache-Control': name === 'index.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    res.end(body)
    return true
  } catch {
    return false
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true })
    if (req.method === 'GET' && (await serveStatic(req, res, url.pathname))) return
    if (req.method === 'POST' && url.pathname === '/api/summarize') {
      if (!rateAllowed(clientIp(req))) return sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
      const body = await readJson(req, MAX_BODY)
      const rawUrl = String(body.url || '').trim()
      const bvid = extractBvid(rawUrl)
      if (!bvid) return sendJson(res, 400, { ok: false, error: '请输入有效的 B 站视频链接（BV 号）' })
      const apiKey = String(body.apiKey || '').trim()
      try {
        const result = await withTimeout(summarize({ bvid, apiKey }), 90_000)
        return sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error).slice(0, 300) })
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/docx') {
      if (!rateAllowed(clientIp(req))) return sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
      const body = await readJson(req, MAX_SUMMARY_BODY)
      const markdown = String(body.markdown || '')
      if (!markdown || markdown.length > 300_000) return sendJson(res, 400, { ok: false, error: 'Markdown 为空或过大' })
      try {
        const file = await makeDocx(markdown, body.title)
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': 'attachment; filename="' + encodeURIComponent(file.filename) + '"',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        return res.end(file.buffer)
      } catch (error) {
        return sendJson(res, 503, { ok: false, error: String(error?.message ?? error).slice(0, 300) })
      }
    }
    sendJson(res, 404, { ok: false, error: 'Not found' })
  } catch (error) {
    if (!res.headersSent) sendJson(res, error?.statusCode || 500, { ok: false, error: String(error?.message ?? error).slice(0, 300) })
    else res.end()
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('course notes web listening on ' + PORT)
})
