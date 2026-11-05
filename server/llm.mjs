/**
 * Standalone LLM bridge: DeepSeek API, local Ollama, or no-LLM.
 *
 * The DSH credential file is read only to obtain the user's existing key; it
 * is never returned to the browser or written to logs.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { getKeychainKey, keychainAvailable } from './keychain.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const OLLAMA_BASE = 'http://127.0.0.1:11434'
const TIMEOUT_MS = 180000

export class LlmError extends Error {
  constructor(message, { status = 0, code = 'LLM_ERROR' } = {}) {
    super(message)
    this.name = 'LlmError'
    this.status = status
    this.code = code
  }
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block) return ''
        if (block.type === 'text') return String(block.text ?? '')
        if (typeof block.text === 'string') return block.text
        return ''
      })
      .join('')
  }
  return String(content ?? '')
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({ role: message.role, content: contentText(message.content) }))
    .filter((message) => message.content.trim() !== '')
}

let dshKeyCache = { mtimeMs: 0, key: '' }

/** Parse ~/.dsh/.credentials.yaml refs.DEEPSEEK_API_KEY without a YAML dependency. */
export function readDshKey(file = join(homedir(), '.dsh', '.credentials.yaml')) {
  try {
    const stat = statSync(file)
    if (dshKeyCache.key && dshKeyCache.mtimeMs === stat.mtimeMs) return dshKeyCache.key
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const block = /^refs:\s*\n((?:[ \t]+.*\n?)*)/m.exec(text)
    if (!block) return ''
    for (const line of block[1].split('\n')) {
      const match = /^\s*DEEPSEEK_API_KEY:\s*(.+?)\s*$/.exec(line)
      if (!match) continue
      const key = match[1].replace(/^["']|["']$/g, '').trim()
      dshKeyCache = { mtimeMs: stat.mtimeMs, key }
      return key
    }
  } catch {
    return ''
  }
  return ''
}

export function resolveKey(config, { env = process.env, keychain = getKeychainKey() } = {}) {
  if (keychain) return { key: keychain, source: 'keychain' }
  if (env.DEEPSEEK_API_KEY) return { key: String(env.DEEPSEEK_API_KEY).trim(), source: 'env' }
  // Legacy config key (only for migration; new writes go to Keychain).
  if (config?.llm?.apiKey) return { key: config.llm.apiKey, source: 'config' }
  return { key: '', source: 'none' }
}

export function keyStatus(config) {
  const resolved = resolveKey(config)
  return {
    provider: config.llm.provider,
    model: config.llm.model,
    keySet: Boolean(resolved.key),
    keySource: resolved.source,
    keychainAvailable: keychainAvailable(),
    useDshKey: config.llm.useDshKey,
  }
}

function timeoutSignal(signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('LLM 请求超时')), TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  return { signal: combined, clear: () => clearTimeout(timer) }
}

function sseBlocks(buffer) {
  const blocks = []
  let rest = buffer
  let index = rest.indexOf('\n\n')
  while (index >= 0) {
    blocks.push(rest.slice(0, index))
    rest = rest.slice(index + 2)
    index = rest.indexOf('\n\n')
  }
  return { blocks, rest }
}

async function* deepseekStream(config, { system, messages, maxTokens, signal, onDelta }) {
  const resolved = resolveKey(config)
  if (!resolved.key) throw new LlmError('未找到 DeepSeek API Key', { code: 'NO_KEY' })
  const url = config.llm.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model: config.llm.model || 'deepseek-chat',
    messages: [
      ...(system ? [{ role: 'system', content: String(system) }] : []),
      ...normalizeMessages(messages),
    ],
    max_tokens: Math.max(1, Number(maxTokens) || 4096),
    temperature: 0.3,
    stream: true,
  }
  const timeout = timeoutSignal(signal)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + resolved.key,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: timeout.signal,
    })
  } finally {
    timeout.clear()
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new LlmError(`DeepSeek HTTP ${res.status}: ${text.slice(0, 180)}`, {
      status: res.status,
      code: 'DEEPSEEK_HTTP',
    })
  }
  if (!res.body) throw new LlmError('DeepSeek 响应没有 body', { code: 'NO_BODY' })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = sseBlocks(buffer)
      buffer = parsed.rest
      for (const block of parsed.blocks) {
        for (const rawLine of block.split('\n')) {
          const line = rawLine.trim()
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let payload
          try {
            payload = JSON.parse(data)
          } catch {
            continue
          }
          const text = payload?.choices?.[0]?.delta?.content
          if (typeof text === 'string' && text.length > 0) {
            onDelta?.(text)
            yield { type: 'text-delta', text }
          }
        }
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }
}

function ollamaBase(config) {
  const base = String(config?.llm?.baseUrl ?? '')
  return base.includes('11434') ? base.replace(/\/+$/, '') : OLLAMA_BASE
}

export async function listOllamaModels({ timeoutMs = 2500 } = {}) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(OLLAMA_BASE + '/api/tags', { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return []
    const data = await res.json()
    return (data?.models ?? []).map((model) => String(model.name ?? model.model ?? '')).filter(Boolean)
  } catch {
    return []
  }
}

async function* ollamaStream(config, { system, messages, maxTokens, signal, onDelta }) {
  const body = {
    model: config.llm.model || 'deepseek-r1:7b',
    messages: [
      ...(system ? [{ role: 'system', content: String(system) }] : []),
      ...normalizeMessages(messages),
    ],
    stream: true,
    options: {
      temperature: 0.3,
      num_predict: Math.max(1, Number(maxTokens) || 2048),
    },
  }
  const timeout = timeoutSignal(signal)
  let res
  try {
    res = await fetch(ollamaBase(config) + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeout.signal,
    })
  } finally {
    timeout.clear()
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new LlmError(`Ollama HTTP ${res.status}: ${text.slice(0, 180)}`, {
      status: res.status,
      code: 'OLLAMA_HTTP',
    })
  }
  if (!res.body) throw new LlmError('Ollama 响应没有 body', { code: 'NO_BODY' })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) {
          try {
            const payload = JSON.parse(line)
            const text = payload?.message?.content
            if (typeof text === 'string' && text.length > 0) {
              onDelta?.(text)
              yield { type: 'text-delta', text }
            }
          } catch {
            /* ignore malformed line */
          }
        }
        index = buffer.indexOf('\n')
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Return a DSH-compatible ctx.llm bridge plus onDelta control.
 */
export function createLlmBridge(config) {
  let onDelta = null
  const controller = new AbortController()
  return {
    ctx: {
      llm: {
        stream: async function* (options) {
          const signal = options.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal
          const merged = { ...options, signal }
          if (config.llm.provider === 'local') {
            throw new LlmError('本地提取模式不调用 LLM', { code: 'LOCAL_MODE' })
          }
          if (config.llm.provider === 'ollama') {
            yield* ollamaStream(config, { ...merged, onDelta })
          } else {
            yield* deepseekStream(config, { ...merged, onDelta })
          }
        },
      },
      get: () => undefined,
    },
    setOnDelta(fn) {
      onDelta = typeof fn === 'function' ? fn : null
    },
    get onDelta() {
      return onDelta
    },
    abort() {
      controller.abort()
    },
  }
}

export async function testLlm(config) {
  const startedAt = Date.now()
  if (config.llm.provider === 'local') {
    return { ok: true, provider: 'local', message: '本地提取模式无需连接', latencyMs: 0 }
  }
  if (config.llm.provider === 'ollama') {
    const models = await listOllamaModels()
    if (models.length === 0) {
      return { ok: false, provider: 'ollama', message: 'Ollama 未运行或没有模型' }
    }
    if (!models.includes(config.llm.model)) {
      return {
        ok: false,
        provider: 'ollama',
        message: `Ollama 没有模型 ${config.llm.model}`,
        models,
      }
    }
    return { ok: true, provider: 'ollama', message: 'Ollama 可用', models, latencyMs: Date.now() - startedAt }
  }
  const resolved = resolveKey(config)
  if (!resolved.key) {
    return { ok: false, provider: 'deepseek', message: '没有可用的 DeepSeek API Key' }
  }
  try {
    const res = await fetch(config.llm.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + resolved.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.llm.model || 'deepseek-chat',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, provider: 'deepseek', message: `HTTP ${res.status}: ${text.slice(0, 120)}` }
    }
    const data = await res.json()
    return {
      ok: true,
      provider: 'deepseek',
      message: 'DeepSeek 连接正常',
      model: data?.model ?? config.llm.model,
      latencyMs: Date.now() - startedAt,
    }
  } catch (error) {
    return { ok: false, provider: 'deepseek', message: String(error?.message ?? error).slice(0, 200) }
  }
}
