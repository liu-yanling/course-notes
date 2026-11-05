/**
 * dsh-video-coursemap — deliver a generated note into a fresh DSH session.
 *
 * DSH exposes `agents` (host) and `agentPresets` (per-preset agent plane).
 * We create a standard session, mount the preset (so the child has present /
 * read / memory tools), rename it, then send one instruction. The child is
 * responsible for `present` and optional memory writes; a watchdog re-prompts
 * once if the deliverable event never appears.
 * @module dsh-video-coursemap/deliver
 */

import { randomUUID } from 'node:crypto'
import { resolveModel, userMessage } from './llm.js'
import { truncate } from './util.js'

export function buildDeliveryPrompt(payload, config) {
  const { video, noteDocx, manualDocx, bullets = [] } = payload
  const title = String(video?.title ?? '视频知识笔记')
  const subject = String(video?.subject ?? '未分类')
  const lines = []
  lines.push(`${config.delivery.sessionTitlePrefix} ${subject}｜${truncate(title, 40)}`)
  lines.push('')
  lines.push('你是「课程助手」的笔记交付会话。刚完成一个 B 站视频的知识总结。')
  lines.push(`视频：${title}`)
  lines.push(`学科：${subject}`)
  if (video?.bvid) lines.push(`BV：${video.bvid}`)
  lines.push('')
  lines.push('已生成的 Word 文档：')
  lines.push(`1. 视频知识总结：${noteDocx}`)
  if (manualDocx) lines.push(`2. 学科学习手册：${manualDocx}`)
  if (bullets.length) {
    lines.push('')
    lines.push('本视频的核心要点：')
    for (const bullet of bullets.slice(0, 6)) lines.push(`- ${bullet}`)
  }
  lines.push('')
  lines.push('请按顺序执行：')
  const presentList = manualDocx
    ? `${noteDocx}（视频总结）和 ${manualDocx}（学科手册）`
    : `${noteDocx}（视频总结）`
  if (config.delivery.present) {
    lines.push(`1. 必须调用 present 工具交付：${presentList}。这是硬性要求，不要只回复文字。`)
  }
  if (config.delivery.memory) {
    lines.push(
      '2. 如果 memory 工具可用：用 target=key 写入 3~6 条本视频的核心事实（学科、关键概念、结论，每条不超过 120 字），用 target=project 写入一行本次学习记录。若不可用则跳过，不要编造工具。',
    )
  } else {
    lines.push('2. 不需要写记忆。')
  }
  lines.push('3. 最后用不超过 5 条要点回复本视频的核心内容；不要重新读取整份文档，也不要修改文件。')
  return lines.join('\n')
}

function sessionDelivered(session) {
  try {
    const events = session?.events
    if (!events) return false
    const iterable = Array.isArray(events)
      ? events
      : typeof events[Symbol.iterator] === 'function'
        ? events
        : []
    for (const event of iterable) {
      if (event?.type === 'deliverables/presented') return true
    }
  } catch {
    /* ignore */
  }
  return false
}

async function resolvePreset(ctx) {
  const presets = ctx.get?.('agentPresets')
  if (!presets || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') {
    return { id: null, setup: null }
  }
  try {
    let resolved
    try {
      resolved = await presets.resolve('standard')
    } catch {
      resolved = await presets.resolve()
    }
    const id = String(resolved?.id ?? 'standard')
    return {
      id,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, id)
      },
    }
  } catch {
    return { id: null, setup: null }
  }
}

async function attachWorkspace(ctx, sessionId, cwd) {
  if (!cwd) return null
  const workspace = ctx.get?.('workspaceRegistry')
  if (!workspace?.resolveByPath || !workspace?.create) return null
  for (const delay of [0, 300, 1200]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      let ws = await workspace.resolveByPath(cwd)
      if (!ws) ws = await workspace.create(cwd)
      await ws.attachSession(sessionId)
      return { ok: true, workspaceId: ws.id, workspaceTitle: ws.title }
    } catch {
      /* retry */
    }
  }
  return { ok: false }
}

/**
 * Create a fresh session and send the delivery instruction.
 * @param {object} ctx plugin context
 * @param {object} config resolved config
 * @param {{video: object, noteDocx: string, manualDocx?: string|null, bullets?: string[]}} payload
 */
export async function deliverToNewSession(ctx, config, payload) {
  const agents = ctx.get?.('agents')
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, error: 'agents 服务不可用，已生成 Word 但未创建新会话' }
  }
  const sessionId = `session-${randomUUID()}`
  const preset = await resolvePreset(ctx)
  const model = resolveModel(ctx, config)
  const cwd = config.delivery.cwd
  let handle
  try {
    handle = await agents.create({
      sessionId,
      agentOptions: { provider: model.provider, model: model.model },
      meta: {
        ...(cwd ? { cwd } : {}),
        ...(preset.id ? { agentPreset: preset.id } : {}),
      },
      ...(preset.setup ? { setup: preset.setup } : {}),
    })
  } catch (error) {
    return { ok: false, error: `创建会话失败：${String(error?.message ?? error)}` }
  }

  const title = `${config.delivery.sessionTitlePrefix} ${payload.video?.subject ?? '未分类'}｜${truncate(
    payload.video?.title ?? '知识笔记',
    36,
  )}`
  try {
    const sessionTitle = ctx.get?.('sessionTitle')
    sessionTitle?.rename?.(handle.agent.session, title)
  } catch {
    /* title is optional */
  }

  const attach = await attachWorkspace(ctx, sessionId, cwd).catch(() => null)
  const prompt = buildDeliveryPrompt(payload, config)
  try {
    handle.agent.followup(userMessage(prompt))
  } catch (error) {
    return { ok: false, sessionId, error: `派发交付任务失败：${String(error?.message ?? error)}` }
  }

  const timer = setTimeout(() => {
    try {
      if (!sessionDelivered(handle.agent.session)) {
        handle.agent.followup(
          userMessage(
            '你还没有调用 present。请现在只调用 present 交付上面列出的 Word 文件（视频总结在前，学科手册在后），然后回复 5 条以内要点。',
          ),
        )
      }
    } catch {
      /* watchdog is best effort */
    }
  }, 60000)
  timer.unref?.()

  return { ok: true, sessionId, title, attach, prompt }
}
