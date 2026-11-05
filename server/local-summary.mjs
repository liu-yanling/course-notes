/**
 * Deterministic extractive summary used when no LLM is available.
 */
import { coverageText } from '../apps/dsh-video-coursemap/lib/bilibili.js'
import { mermaidSafe, truncate, uniqueStrings } from '../apps/dsh-video-coursemap/lib/util.js'

function sentences(text, limit = 8) {
  return uniqueStrings(
    String(text ?? '')
      .replace(/\s+/g, ' ')
      .split(/[。！？!?]|\n/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 8 && line.length <= 180),
    limit,
  )
}

function chapterTitles(content) {
  return uniqueStrings(
    (content?.pages ?? []).map((page) => String(page.title ?? '').trim()),
    12,
  )
}

export function buildLocalSummary({ title, subject, keywords = [], content = null }) {
  const safeTitle = String(title ?? '视频知识笔记').trim() || '视频知识笔记'
  const summaryLine = content?.desc
    ? truncate(String(content.desc).split(/[。！？\n]/)[0], 100)
    : `本视频围绕「${safeTitle}」展开，建议结合视频画面与章节顺序学习。`
  const chapters = chapterTitles(content)
  const tags = uniqueStrings([...(keywords ?? []), ...(content?.tags ?? [])], 12)
  const danmaku = uniqueStrings(content?.danmaku ?? [], 10)
  const comments = uniqueStrings(
    (content?.comments ?? []).map((comment) => String(comment?.text ?? '').trim()),
    5,
  )
  const descPoints = sentences(content?.desc, 6)
  const lines = []

  lines.push('# ' + safeTitle)
  lines.push('')
  lines.push('> ' + summaryLine)
  lines.push('')
  lines.push('## 学习目标')
  lines.push('- 理解视频的主题、章节结构与核心概念')
  lines.push('- 结合弹幕/评论中的常见问题复盘重点')
  lines.push('')
  lines.push('## 核心知识点')

  if (descPoints.length) {
    lines.push('- **视频简介提炼**')
    for (const point of descPoints) lines.push('  - ' + point)
  }
  if (chapters.length) {
    lines.push('- **章节脉络**')
    for (const chapter of chapters.slice(0, 8)) lines.push('  - ' + chapter)
  }
  if (tags.length) {
    lines.push('- **关键词与主题**')
    for (const tag of tags.slice(0, 8)) lines.push('  - ' + tag)
  }
  if (!descPoints.length && !chapters.length && !tags.length) {
    lines.push('- **待补充**')
    lines.push('  - 未抓取到足够的视频内容，建议补充字幕或重新运行。')
  }
  lines.push('')
  lines.push('## 关键概念与术语')
  if (tags.length) {
    for (const tag of tags.slice(0, 8)) lines.push(`- **${tag}**：本视频涉及的主题关键词。`)
  } else {
    lines.push('- **待补充**：未抓到标签或术语。')
  }
  lines.push('')
  lines.push('## 弹幕与评论区洞察')
  if (comments.length || danmaku.length) {
    for (const comment of comments) lines.push('- 评论：' + truncate(comment, 100))
    for (const item of danmaku.slice(0, 6)) lines.push('- 弹幕：' + truncate(item, 80))
  } else {
    lines.push('- 本次未抓取到有效讨论。')
  }
  lines.push('')
  lines.push('## 思维导图')
  lines.push('```mermaid')
  lines.push('mindmap')
  lines.push('  root((' + mermaidSafe(safeTitle) + '))')
  for (const chapter of chapters.slice(0, 6)) lines.push('    ' + mermaidSafe(chapter, 40))
  for (const tag of tags.slice(0, 4)) lines.push('    ' + mermaidSafe(tag, 30))
  lines.push('```')
  lines.push('')
  lines.push('## 复习清单')
  lines.push('- [ ] 用自己的话复述本视频的核心主题。')
  if (chapters.length) lines.push('- [ ] 按章节顺序回顾一次，标记没听懂的部分。')
  lines.push('- [ ] 从弹幕/评论中挑一个疑问，尝试回答。')
  lines.push('')
  lines.push('## 内容来源与覆盖度')
  lines.push('- 抓取覆盖：' + coverageText(content))
  lines.push('- 说明：当前使用本地提取模式（未调用 LLM），内容为简介/章节/标签/弹幕/评论的结构化整理。')
  lines.push('')
  return lines.join('\n')
}
