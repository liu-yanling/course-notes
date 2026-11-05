/**
 * Browser-free LLM bridge for the public web MVP.
 *
 * The user's DeepSeek key is held only in memory for the duration of a
 * request. It is never persisted, logged, or passed to another service.
 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const DEFAULT_MODEL = 'deepseek-chat'

function messageText(message) {
  const parts = Array.isArray(message?.content) ? message.content : []
  return parts
    .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
    .join('')
}

export function hasKey(apiKey) {
  return Boolean(String(apiKey ?? '').trim())
}

export function createWebContext(apiKey) {
  const key = String(apiKey ?? '').trim()
  return {
    get: () => null,
    llm: {
      stream(input) {
        return deepseekStream(key, input)
      },
    },
  }
}

async function* deepseekStream(apiKey, input) {
  const baseUrl = String(process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = String(process.env.DEEPSEEK_MODEL || DEFAULT_MODEL)
  const messages = []
  if (input.system) messages.push({ role: 'system', content: String(input.system) })
  for (const message of input.messages ?? []) {
    messages.push({ role: message.role, content: messageText(message) })
  }
  const response = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: input.maxTokens ?? 4096,
      stream: true,
    }),
    signal: input.signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error('DeepSeek 请求失败：HTTP ' + response.status + ' ' + text.slice(0, 160))
  }
  if (!response.body) throw new Error('DeepSeek 没有返回流')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const event = JSON.parse(payload)
        const text = event?.choices?.[0]?.delta?.content
        if (typeof text === 'string' && text) yield { type: 'text-delta', text }
      } catch {
        /* ignore malformed SSE chunk */
      }
    }
  }
}
