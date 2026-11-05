/**
 * dsh-video-coursemap — durable state, paths and dedupe helpers.
 *
 * State is a single JSON file under <outputDir>/.state/state.json. Writes are
 * atomic (write temp + rename) so a crash never leaves a truncated state.
 * @module dsh-video-coursemap/state
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  bigramSimilarity,
  normalizeTitle,
  sanitizeFileName,
  shortHash,
  timeStamp,
  uniqueStrings,
} from './util.js'

export const STATE_SCHEMA = 2
export const SEEN_LIMIT = 1000
export const SEEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

export function ensureDir(path) {
  if (path && !existsSync(path)) mkdirSync(path, { recursive: true })
}

export function atomicWrite(file, content) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function emptyState() {
  return {
    schema: STATE_SCHEMA,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    subjects: {},
    videos: {},
    seen: {},
    lastObservation: null,
    lastDelivery: null,
  }
}

export function loadState(statePath) {
  const parsed = readJsonFile(statePath)
  const state = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : emptyState()
  if (!state.subjects || typeof state.subjects !== 'object') state.subjects = {}
  if (!state.videos || typeof state.videos !== 'object') state.videos = {}
  if (!state.seen || typeof state.seen !== 'object') state.seen = {}
  state.schema = STATE_SCHEMA
  state.createdAt = Number(state.createdAt) || Date.now()
  state.updatedAt = Number(state.updatedAt) || Date.now()
  return state
}

export function saveState(statePath, state) {
  state.schema = STATE_SCHEMA
  state.updatedAt = Date.now()
  atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n')
}

/** All paths used by the app. */
export function pathsFor(config) {
  const root = config.outputDir
  const stateDir = join(root, '.state')
  return {
    root,
    stateDir,
    statePath: join(stateDir, 'state.json'),
    notesDir: join(stateDir, 'notes'),
    manualsDir: join(stateDir, 'manuals'),
    logsDir: join(stateDir, 'logs'),
    videosDir: join(root, '视频笔记'),
    overviewDocx: join(root, '课程总览.docx'),
    overviewMd: join(root, '知识地图.md'),
    logPath: join(stateDir, 'logs', 'course.log'),
  }
}

export function ensureLayout(paths) {
  for (const dir of [
    paths.root,
    paths.stateDir,
    paths.notesDir,
    paths.manualsDir,
    paths.logsDir,
    paths.videosDir,
  ]) {
    ensureDir(dir)
  }
}

/** Dedupe key: bvid is authoritative, normalized title is the fallback. */
export function seenKey({ bvid, title, url }) {
  if (bvid) return `bvid:${bvid}`
  const fromUrl = String(url ?? '').match(/(BV[0-9A-Za-z]{10})/)
  if (fromUrl) return `bvid:${fromUrl[1]}`
  const normalized = normalizeTitle(title)
  return normalized ? `title:${shortHash(normalized, 12)}` : null
}

export function isSeen(state, video) {
  const key = seenKey(video)
  if (!key) return false
  if (Object.hasOwn(state.seen, key)) return true
  const normalized = normalizeTitle(video?.title)
  if (normalized) {
    for (const entry of Object.values(state.seen)) {
      if (entry && normalizeTitle(entry.title) === normalized) return true
    }
  }
  return false
}

export function markSeen(state, video, status, extra = {}) {
  const key = seenKey(video)
  if (!key) return null
  state.seen[key] = {
    at: Date.now(),
    title: String(video?.title ?? ''),
    bvid: video?.bvid ?? null,
    subject: extra.subject ?? null,
    status,
    ...extra,
  }
  pruneSeen(state)
  return key
}

export function pruneSeen(state, limit = SEEN_LIMIT, ttl = SEEN_TTL_MS) {
  const entries = Object.entries(state.seen ?? {})
  const now = Date.now()
  for (const [key, entry] of entries) {
    if (!entry || now - Number(entry.at ?? 0) > ttl) delete state.seen[key]
  }
  const rest = Object.entries(state.seen ?? {})
  if (rest.length <= limit) return state
  rest.sort((a, b) => Number(a[1]?.at ?? 0) - Number(b[1]?.at ?? 0))
  for (const [key] of rest.slice(0, rest.length - limit)) delete state.seen[key]
  return state
}

/** Reuse an existing subject when the LLM returns a close variant. */
export function matchSubject(subject, existingSubjects, threshold = 0.82) {
  const target = String(subject ?? '').trim()
  if (!target) return null
  const names = Object.keys(existingSubjects ?? {})
  const normalized = normalizeTitle(target)
  const exact = names.find((name) => normalizeTitle(name) === normalized)
  if (exact) return exact
  let best = null
  let bestScore = 0
  for (const name of names) {
    const score = bigramSimilarity(name, target)
    if (score > bestScore) {
      bestScore = score
      best = name
    }
  }
  return best && bestScore >= threshold ? best : null
}

export function subjectNames(state) {
  return Object.keys(state.subjects ?? {}).sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

export function ensureSubject(state, subject) {
  const name = String(subject ?? '').trim() || '未分类'
  if (!state.subjects[name]) {
    state.subjects[name] = {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      keywords: [],
      videos: [],
    }
  }
  return state.subjects[name]
}

export function subjectKeywords(state, subject, limit = 20) {
  const entry = state.subjects?.[subject]
  if (!entry) return []
  return uniqueStrings(entry.keywords ?? [], limit)
}

export function addKeywords(state, subject, keywords) {
  const entry = ensureSubject(state, subject)
  entry.keywords = uniqueStrings([...(entry.keywords ?? []), ...(keywords ?? [])], 40)
  entry.updatedAt = Date.now()
}

/**
 * Record a processed video. Returns { isNewSubject, isNewVideo, video }.
 */
export function upsertVideo(state, video) {
  const key = video.bvid || `title-${shortHash(normalizeTitle(video.title), 12)}`
  const existing = state.videos[key]
  const isNewVideo = !existing
  const subject = ensureSubject(state, video.subject)
  const isNewSubject = (subject.videos ?? []).length === 0
  const record = {
    ...(existing ?? {}),
    ...video,
    key,
    addedAt: existing?.addedAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  state.videos[key] = record
  if (!subject.videos.includes(key)) subject.videos.push(key)
  subject.updatedAt = Date.now()
  return { isNewSubject, isNewVideo, video: record }
}

export function subjectVideos(state, subject) {
  const entry = state.subjects?.[subject]
  if (!entry) return []
  return (entry.videos ?? [])
    .map((key) => state.videos?.[key])
    .filter(Boolean)
    .sort((a, b) => Number(a.addedAt ?? 0) - Number(b.addedAt ?? 0))
}

export function allVideos(state) {
  return Object.values(state.videos ?? {}).sort(
    (a, b) => Number(b.addedAt ?? 0) - Number(a.addedAt ?? 0),
  )
}

export function noteFileName(video) {
  const date = video.date ?? new Date().toISOString().slice(0, 10)
  const title = sanitizeFileName(video.title, 56)
  const suffix = video.bvid || shortHash(video.title, 8)
  return `${date}_${title}_${suffix}.docx`
}

export function relativeOutput(config, absolutePath) {
  const root = config.outputDir
  return absolutePath.startsWith(root + '/') ? absolutePath.slice(root.length + 1) : absolutePath
}

export function formatUpdatedAt(state) {
  const stamp = Number(state.updatedAt ?? 0)
  return stamp ? timeStamp(new Date(stamp)) : '（未知）'
}

/** Remove a file if it exists; used by rebuilds. */
export function removeIfExists(file) {
  try {
    if (existsSync(file)) rmSync(file, { force: true })
  } catch {
    /* ignore */
  }
}

export function readIfExists(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
