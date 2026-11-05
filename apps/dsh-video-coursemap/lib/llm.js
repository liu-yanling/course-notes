/**
 * dsh-video-coursemap — LLM helpers shared by classification and summary.
 * @module dsh-video-coursemap/llm
 */

import { randomUUID } from 'node:crypto'

export function userMessage(text) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: String(text ?? '') }],
  }
}

/** Pick a provider/model, preferring the DSH default selection. */
export function resolveModel(ctx, config = {}) {
  if (config.provider && config.model) {
    return { provider: config.provider, model: config.model }
  }
  try {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (selection?.provider && selection?.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* ignore */
  }
  try {
    for (const provider of ctx.llm?.listProviders?.() ?? []) {
      const model = provider.models?.[0]?.id ?? provider.defaultModel ?? provider.model
      if (provider.id && model) return { provider: provider.id, model }
    }
  } catch {
    /* ignore */
  }
  return { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
}

/**
 * Run one non-streaming-in-spirit LLM call, collecting text deltas.
 * @param {object} ctx plugin context
 * @param {object} config resolved config
 * @param {{system?: string, messages: object[], maxTokens?: number, timeoutMs?: number}} input
 */
export async function callLlm(ctx, config, input) {
  const model = resolveModel(ctx, config)
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('dsh-video-coursemap: LLM 调用超时')),
    input.timeoutMs ?? 120000,
  )
  try {
    const stream = ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      system: input.system,
      messages: input.messages,
      maxTokens: input.maxTokens ?? config.maxTokens,
      signal: controller.signal,
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
    return text
  } finally {
    clearTimeout(timeout)
  }
}
