/**
 * dsh-video-coursemap — knowledge-note generation prompts and post-processing.
 * @module dsh-video-coursemap/summarize
 */

import { callLlm, userMessage } from './llm.js'
import { mermaidSafe, stripFirstH1, truncate, uniqueStrings } from './util.js'
import { coverageText } from './bilibili.js'

function contentBlock(content, config) {
  if (!content) {
    return {
      text: '未抓取到 B 站内容（可能无网络、接口风控或未识别到视频）。只能基于标题与关键词合理推断，必须在笔记中明确标注。',
      hasContent: false,
    }
  }
  const maxDesc = config.summary?.maxDescChars ?? 1200
  const parts = []
  if (content.desc) parts.push('【视频简介】\n' + truncate(content.desc, maxDesc))
  if (content.pages?.length) {
    parts.push(
      '【分P/章节】\n' +
        content.pages
          .slice(0, 20)
          .map((page) => `P${page.page} ${page.title}（${page.duration}s）`)
          .join('\n'),
    )
  }
  if (content.tags?.length) parts.push('【标签】\n' + content.tags.join('、'))
  if (content.transcript) parts.push('【字幕/讲解文本（节选）】\n' + truncate(content.transcript, 4000))
  if (content.danmaku?.length) {
    parts.push(`【弹幕（按时间抽样 ${content.danmaku.length} 条）】\n` + content.danmaku.join('\n'))
  }
  if (content.comments?.length) {
    parts.push(
      `【热评（${content.comments.length} 条）】\n` +
        content.comments.map((row, index) => `${index + 1}. ${row.text}`).join('\n'),
    )
  }
  if (parts.length === 0) {
    return { text: '未抓取到可用的视频内容。', hasContent: false }
  }
  return {
    text:
      `已抓取到以下视频内容/弹幕/评论（覆盖度：${coverageText(content)}）。请优先基于它们总结，不要凭空编造：\n\n` +
      parts.join('\n\n'),
    hasContent: true,
  }
}

export function buildSummaryPrompt({ title, subject, keywords, content }, config) {
  const system =
    '你是学习笔记整理专家，为视频课程生成「知识地图」（Markdown + Mermaid 思维导图）。你只输出 Markdown，不输出解释。'
  const block = contentBlock(content, config)
  const safeTitle = mermaidSafe(title)
  const user = `视频标题：${title}
学科：${subject}
关键词：${(keywords ?? []).join('、')}

${block.text}

只返回 Markdown（不要任何首尾说明），严格使用以下结构：

# ${title}

> 一句话总结本视频的核心内容

## 学习目标
- 学完本视频能掌握什么（2~4 条）

## 核心知识点
- **主题一**
  - 要点
  - 要点
- **主题二**
  - 要点

## 关键概念与术语
- **术语**：解释

## 弹幕与评论区洞察
- 观众关注/讨论/争议的重点（2~4 条；没有数据时写「本次未抓取到有效讨论」）

## 思维导图
\`\`\`mermaid
mindmap
  root((${safeTitle}))
    ...
\`\`\`

## 复习清单
- [ ] 可自测的问题或练习（3~6 条）

## 内容来源与覆盖度
- 抓取覆盖：${coverageText(content)}
- 说明：${block.hasContent ? '优先依据简介/分P/字幕/弹幕/评论提炼，未出现的内容不编造。' : '未获取到视频正文，以下内容基于标题与关键词推断，需谨慎使用。'}

要求：
- 全部用中文；核心知识点 8~20 条、分 2~3 层；术语 3~8 个；复习清单 3~6 条。
- 弹幕与评论只提炼「观众关注点/争议/补充」，不要把口水话原样堆砌。
- mermaid 使用 mindmap 语法、2~3 层，节点文字避免括号等特殊字符。
- 如果抓取内容里出现与标题无关的信息，忽略它。`
  return { system, user }
}

export function fallbackMindmap(title, keywords = []) {
  const root = mermaidSafe(title)
  const nodes = uniqueStrings(keywords, 6).map((keyword) => '    ' + mermaidSafe(keyword))
  return [
    '```mermaid',
    'mindmap',
    `  root((${root}))`,
    ...(nodes.length ? nodes : ['    核心概念', '    学习路径']),
    '```',
  ].join('\n')
}

function closeUnclosedFences(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence && /^##\s+/.test(trimmed)) {
      out.push('```')
      inFence = false
    }
    out.push(line)
  }
  if (inFence) out.push('```')
  return out.join('\n')
}

/** Ensure headings / mermaid exist even if the model ignored the template. */
export function normalizeSummary(markdown, { title, keywords = [] } = {}) {
  let text = String(markdown ?? '').trim()
  if (!text) text = `# ${title}\n\n> 本次生成内容为空，请重试。`
  text = text.replace(/^\s*```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/, '')
  text = closeUnclosedFences(text)
  if (!/^#\s+/.test(text)) text = `# ${title}\n\n` + text
  if (!/^##\s+核心知识点/m.test(text)) {
    text += '\n\n## 核心知识点\n- **待补充**\n  - 本次抓取内容不足，建议重新生成或补充字幕。'
  }
  if (!/^##\s+复习清单/m.test(text)) {
    text += '\n\n## 复习清单\n- [ ] 用自己的话复述本视频的核心结论。'
  }
  const mermaid = /\`\`\`mermaid([\s\S]*?)\`\`\`/.exec(text)
  if (!mermaid || !/mindmap/i.test(mermaid[1] ?? '')) {
    text = text.replace(/\`\`\`mermaid[\s\S]*?\`\`\`\s*/g, '')
    text += '\n\n## 思维导图\n' + fallbackMindmap(title, keywords) + '\n'
  }
  if (!/^##\s+内容来源与覆盖度/m.test(text)) {
    text += '\n\n## 内容来源与覆盖度\n- 说明：由课程助手自动生成。\n'
  }
  return text.trim()
}

/**
 * Generate one video's Markdown knowledge note.
 * @param {object} ctx plugin context
 * @param {object} config resolved config
 * @param {{title: string, subject: string, keywords: string[], content: object|null}} input
 */
export async function generateSummary(ctx, config, input) {
  const prompt = buildSummaryPrompt(input, config)
  let text = ''
  try {
    text = await callLlm(ctx, config, {
      system: prompt.system,
      messages: [userMessage(prompt.user)],
      maxTokens: config.maxTokens,
      timeoutMs: 180000,
    })
  } catch (error) {
    text = `# ${input.title}\n\n> 本次 LLM 总结失败：${String(error?.message ?? error).slice(
      0,
      200,
    )}\n\n## 核心知识点\n- **待补充**\n  - 可稍后调用 course_map_rebuild 重试。\n`
  }
  return normalizeSummary(text, { title: input.title, keywords: input.keywords })
}

/** Pull 5-8 short bullets for the delivery-session prompt. */
export function digestBullets(markdown, limit = 6) {
  const body = stripFirstH1(markdown)
  const lines = body.split(/\r?\n/)
  const bullets = []
  let inKnowledge = false
  for (const line of lines) {
    if (/^##\s+核心知识点/.test(line)) {
      inKnowledge = true
      continue
    }
    if (inKnowledge && /^##\s+/.test(line)) break
    const match = /^\s*[-*]\s+(.*)$/.exec(line)
    if (match) {
      const text = match[1]
        .replace(/\*\*/g, '')
        .replace(/^\s*\[.\]\s*/, '')
        .trim()
      if (text) bullets.push(text)
    }
  }
  if (bullets.length === 0) {
    for (const line of lines) {
      const text = line.replace(/^[#>\-*\s]+/, '').trim()
      if (text.length >= 12 && !/^```/.test(line)) bullets.push(text)
      if (bullets.length >= limit) break
    }
  }
  return uniqueStrings(bullets, limit).map((text) => truncate(text, 100))
}
