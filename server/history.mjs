/**
 * History built from the shared state plus a filesystem scan fallback.
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  allVideos,
  loadState,
  pathsFor,
  readIfExists,
  subjectNames,
} from '../apps/dsh-video-coursemap/lib/state.js'

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function fileInfo(path) {
  try {
    const stat = statSync(path)
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null
  } catch {
    return null
  }
}

function parseNoteName(name) {
  const base = name.replace(/\.docx$/i, '')
  const match = /^(\d{4}-\d{2}-\d{2})_(.+?)_(BV[0-9A-Za-z]{10})$/.exec(base)
  if (match) return { date: match[1], title: match[2].replace(/_/g, ' '), bvid: match[3] }
  return { date: '', title: base.replace(/_/g, ' '), bvid: '' }
}

export function buildHistory(config) {
  const paths = pathsFor({ outputDir: config.outputDir })
  const state = loadState(paths.statePath)
  const videos = allVideos(state).map((video) => ({
    key: video.key ?? video.bvid ?? '',
    bvid: video.bvid ?? '',
    title: video.title ?? '',
    subject: video.subject ?? '未分类',
    date: video.date ?? '',
    addedAt: video.addedAt ?? 0,
    keywords: video.keywords ?? [],
    coverage: video.coverage ?? null,
    pic: video.pic ?? '',
    noteDocx: fileInfo(video.noteDocx) ? video.noteDocx : null,
    manualDocx: fileInfo(video.manualDocx) ? video.manualDocx : null,
    noteMd: fileInfo(video.noteMd) ? video.noteMd : null,
  }))

  // Demo/pre-state files: show existing Word notes even without state.
  const knownNotes = new Set(videos.map((video) => video.noteDocx).filter(Boolean))
  for (const entry of listDir(paths.videosDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.docx')) continue
    const noteDocx = join(paths.videosDir, entry.name)
    if (knownNotes.has(noteDocx)) continue
    const parsed = parseNoteName(entry.name)
    const info = fileInfo(noteDocx)
    if (!info) continue
    videos.push({
      key: parsed.bvid || noteDocx,
      bvid: parsed.bvid,
      title: parsed.title,
      subject: '未归档',
      date: parsed.date,
      addedAt: info.mtimeMs,
      keywords: [],
      coverage: null,
      pic: '',
      noteDocx,
      manualDocx: null,
      noteMd: null,
    })
  }

  videos.sort((a, b) => Number(b.addedAt ?? 0) - Number(a.addedAt ?? 0))

  const subjects = subjectNames(state).map((name) => {
    const data = state.subjects[name] ?? {}
    const manualDocx = join(paths.root, name, '学习手册.docx')
    return {
      name,
      count: data.videos?.length ?? 0,
      keywords: data.keywords ?? [],
      updatedAt: data.updatedAt ?? 0,
      manualDocx: fileInfo(manualDocx) ? manualDocx : null,
    }
  })
  const knownSubjects = new Set(subjects.map((subject) => subject.name))
  for (const entry of listDir(paths.root)) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.state' || entry.name === '视频笔记') continue
    const manualDocx = join(paths.root, entry.name, '学习手册.docx')
    if (!fileInfo(manualDocx) || knownSubjects.has(entry.name)) continue
    subjects.push({
      name: entry.name,
      count: videos.filter((video) => video.subject === entry.name).length,
      keywords: [],
      updatedAt: 0,
      manualDocx,
    })
  }

  return {
    subjects,
    videos,
    overviewDocx: fileInfo(paths.overviewDocx) ? paths.overviewDocx : null,
    outputDir: paths.root,
    statePath: paths.statePath,
    updatedAt: state.updatedAt ?? 0,
  }
}

export function getVideoDetail(config, { key, bvid } = {}) {
  const paths = pathsFor({ outputDir: config.outputDir })
  const state = loadState(paths.statePath)
  const target = Object.values(state.videos ?? {}).find(
    (video) => (key && (video.key === key || video.bvid === key)) || (bvid && video.bvid === bvid),
  )
  if (!target) {
    const history = buildHistory(config)
    const fallback = history.videos.find(
      (video) => (key && (video.key === key || video.bvid === key)) || (bvid && video.bvid === bvid),
    )
    if (!fallback) return null
    return { ...fallback, markdown: '', noteMd: null }
  }
  const noteMd = target.noteMd ?? join(paths.notesDir, basename(target.noteMd ?? '') || '')
  return {
    key: target.key ?? target.bvid ?? '',
    bvid: target.bvid ?? '',
    title: target.title ?? '',
    subject: target.subject ?? '未分类',
    date: target.date ?? '',
    keywords: target.keywords ?? [],
    coverage: target.coverage ?? null,
    pic: target.pic ?? '',
    noteDocx: fileInfo(target.noteDocx) ? target.noteDocx : null,
    manualDocx: fileInfo(target.manualDocx) ? target.manualDocx : null,
    noteMd: fileInfo(noteMd) ? noteMd : null,
    markdown: readIfExists(noteMd),
  }
}
