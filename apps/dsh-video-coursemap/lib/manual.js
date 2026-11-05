/**
 * dsh-video-coursemap — Markdown assembly for video notes, subject manuals and
 * the global overview. The Python bridge turns these into Word documents.
 * @module dsh-video-coursemap/manual
 */

import { basename, join } from 'node:path'
import {
  dateStamp,
  mermaidSafe,
  sanitizeFileName,
  sanitizeSubject,
  stripFirstH1,
  timeStamp,
  truncate,
  uniqueStrings,
} from './util.js'
import { coverageText } from './bilibili.js'

export function videoDate(video) {
  const stamp = Number(video?.addedAt ?? Date.now())
  return dateStamp(new Date(stamp))
}

export function buildVideoMeta(video, content) {
  return {
    kind: 'video',
    title: video.title,
    subject: video.subject,
    owner: content?.owner ?? video.owner ?? '',
    bvid: video.bvid ?? '',
    url: content?.url ?? video.url ?? '',
    date: videoDate(video),
    generatedAt: timeStamp(new Date()),
    duration: content?.duration ?? 0,
    stats: {
      view: content?.stat?.view ?? 0,
      like: content?.stat?.like ?? 0,
      coin: content?.stat?.coin ?? 0,
      favorite: content?.stat?.favorite ?? 0,
      reply: content?.stat?.reply ?? 0,
      danmaku: content?.stat?.danmaku ?? 0,
    },
    coverage: coverageText(content),
    keywords: video.keywords ?? [],
  }
}

export function renderVideoNote(markdown, meta) {
  const body = String(markdown ?? '').trim()
  const quote = [
    meta.subject ? `学科：${meta.subject}` : null,
    meta.owner ? `UP：${meta.owner}` : null,
    meta.date ? `日期：${meta.date}` : null,
    meta.bvid ? `BV：${meta.bvid}` : null,
    meta.coverage ? `覆盖：${meta.coverage}` : null,
  ]
    .filter(Boolean)
    .join(' ｜ ')
  if (!quote) return body
  if (/^#\s+/.test(body)) {
    return body.replace(/^#\s+([^\n]*)\n?/, (_match, heading) => `# ${heading}\n\n> ${quote}\n`)
  }
  return `# ${meta.title}\n\n> ${quote}\n\n` + body
}

export function buildSubjectMindmap(subject, videos) {
  const lines = ['```mermaid', 'mindmap', `  root((${mermaidSafe(subject)}))`]
  for (const video of videos.slice(0, 30)) {
    lines.push(`    ${mermaidSafe(video.title, 48)}`)
  }
  lines.push('```')
  return lines.join('\n')
}

export function renderSubjectManual(subject, videos, state) {
  const lines = []
  const keywords = uniqueStrings(
    videos.flatMap((video) => video.keywords ?? []),
    20,
  )
  lines.push(`# ${subject} 学习手册`)
  lines.push('')
  lines.push(
    `> 共 ${videos.length} 个视频 ｜ 最近更新 ${timeStamp(new Date(state.updatedAt ?? Date.now()))}`,
  )
  lines.push('')
  lines.push('## 学科总览')
  lines.push(buildSubjectMindmap(subject, videos))
  lines.push('')
  lines.push('## 学习路径')
  if (videos.length === 0) {
    lines.push('（暂无视频）')
  } else {
    videos.forEach((video, index) => {
      lines.push(`${index + 1}. **${video.title}** — ${video.date ?? ''}`)
    })
  }
  lines.push('')
  lines.push('## 已覆盖关键词')
  lines.push(keywords.length ? keywords.map((keyword) => `- ${keyword}`).join('\n') : '- （暂无）')
  lines.push('')
  for (const video of videos) {
    lines.push('---')
    lines.push('')
    lines.push(`## ${video.title}`)
    lines.push('')
    lines.push(stripFirstH1(video.markdown ?? '').trim())
    lines.push('')
  }
  return lines.join('\n').trim() + '\n'
}

export function renderOverview(state) {
  const subjects = Object.keys(state.subjects ?? {}).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const videos = Object.values(state.videos ?? {}).sort(
    (a, b) => Number(b.addedAt ?? 0) - Number(a.addedAt ?? 0),
  )
  const lines = []
  lines.push('# 视频课程知识地图')
  lines.push('')
  lines.push(
    `> 学科 ${subjects.length} 个 ｜ 视频 ${videos.length} 个 ｜ 更新 ${timeStamp(
      new Date(state.updatedAt ?? Date.now()),
    )}`,
  )
  lines.push('')
  lines.push('## 学科总览')
  lines.push('```mermaid')
  lines.push('mindmap')
  lines.push('  root((课程知识地图))')
  for (const subject of subjects) {
    lines.push(`    ${mermaidSafe(subject, 30)}`)
  }
  lines.push('```')
  lines.push('')
  lines.push('## 学科列表')
  if (subjects.length === 0) {
    lines.push('（暂无，开始观看视频课程后会自动生成）')
  } else {
    for (const subject of subjects) {
      const count = state.subjects[subject]?.videos?.length ?? 0
      lines.push(`- **${subject}** — ${count} 个视频 → 「课程知识地图/${sanitizeSubject(subject)}/学习手册.docx」`)
    }
  }
  lines.push('')
  lines.push('## 最近学习')
  if (videos.length === 0) {
    lines.push('（暂无）')
  } else {
    for (const video of videos.slice(0, 10)) {
      const notePath = video.noteDocx
        ? `视频笔记/${basename(video.noteDocx)}`
        : `视频笔记/${sanitizeFileName(video.title, 40)}.docx`
      lines.push(`- ${video.date ?? ''} · **${video.title}** · ${video.subject ?? ''} → 「${notePath}」`)
    }
  }
  lines.push('')
  lines.push('## 使用说明')
  lines.push('- 本文件由课程助手自动生成；原始 Markdown 源在 `.state/notes/` 与 `.state/manuals/`。')
  lines.push('- 重新生成全部 Word：调用 `course_map_rebuild`。')
  lines.push('')
  return lines.join('\n').trim() + '\n'
}

export function buildManualMeta(subject, videos, state) {
  return {
    kind: 'manual',
    title: `${subject} 学习手册`,
    subject,
    subtitle: `视频知识地图 · 共 ${videos.length} 个视频`,
    date: dateStamp(new Date()),
    generatedAt: timeStamp(new Date(state.updatedAt ?? Date.now())),
    keywords: uniqueStrings(
      videos.flatMap((video) => video.keywords ?? []),
      20,
    ),
  }
}

export function buildOverviewMeta(state) {
  const subjectCount = Object.keys(state.subjects ?? {}).length
  const videoCount = Object.keys(state.videos ?? {}).length
  return {
    kind: 'overview',
    title: '视频课程知识地图',
    subtitle: `学科 ${subjectCount} 个 · 视频 ${videoCount} 个`,
    date: dateStamp(new Date()),
    generatedAt: timeStamp(new Date(state.updatedAt ?? Date.now())),
  }
}

export function noteMarkdownPath(config, paths, video) {
  const key = video.bvid || `title-${sanitizeFileName(video.title, 40)}`
  return join(paths.notesDir, `${sanitizeFileName(key, 60)}.md`)
}

export function manualMarkdownPath(paths, subject) {
  return join(paths.manualsDir, `${sanitizeSubject(subject)}.md`)
}

export function summaryExcerpt(markdown, length = 240) {
  const text = String(markdown ?? '')
    .replace(/^#\s+.*$/m, '')
    .replace(/^>\s+.*$/m, '')
    .replace(/[#*_>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return truncate(text, length)
}
