/**
 * dsh-video-coursemap — shared pure helpers.
 *
 * Everything here is dependency-free and testable outside DSH.
 * @module dsh-video-coursemap/util
 */

export const BILI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Strip HTML tags (Bilibili search titles contain <em>). */
export function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]+>/g, '').trim()
}

/** Decode the five XML entities Bilibili emits. */
export function decodeXml(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** Normalize a title for dedupe / similarity. */
export function normalizeTitle(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** Dice bigram similarity in [0, 1]. */
export function bigramSimilarity(a, b) {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 1
  const grams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
    return set
  }
  const A = grams(na)
  const B = grams(nb)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const gram of A) if (B.has(gram)) inter += 1
  return (2 * inter) / (A.size + B.size)
}

/** Strip browser / platform suffixes from a window or tab title. */
const TITLE_SUFFIXES = [
  ' - Google Chrome',
  ' - Microsoft Edge',
  ' - Mozilla Firefox',
  ' - Chromium',
  ' - Opera',
  ' - Brave',
  ' - Safari',
  ' - 谷歌浏览器',
  ' - 微软 Edge',
  ' - 火狐浏览器',
  '_哔哩哔哩_bilibili',
  '_哔哩哔哩',
  ' - 哔哩哔哩',
  ' - bilibili',
  '-bilibili',
  ' - Bilibili',
  ' - YouTube',
  ' - 优酷',
  ' - 爱奇艺',
  ' - 腾讯视频',
  ' - 芒果TV',
  ' - 抖音',
  ' - 快手',
  ' - 夸克',
  ' - Quark',
]

export function cleanBrowserTitle(raw) {
  let title = String(raw ?? '').trim()
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of TITLE_SUFFIXES) {
      if (title.endsWith(suffix)) {
        title = title.slice(0, -suffix.length).trim()
        changed = true
      }
    }
  }
  return title
}

/** A safe directory / file name for macOS + Windows. */
export function sanitizeFileName(value, max = 80) {
  const clean = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
  return (clean || '未命名').slice(0, max)
}

/** A subject label (keeps Chinese, strips path separators). */
export function sanitizeSubject(value) {
  return sanitizeFileName(value, 24).replace(/_/g, '').trim() || '未分类'
}

/** Mermaid mindmap node text: drop syntax chars. */
export function mermaidSafe(value, max = 60) {
  return String(value ?? '')
    .replace(/[()[\]{}|<>'"`\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || '知识地图'
}

export function truncate(value, max) {
  const text = String(value ?? '')
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'
}

export function uniqueStrings(list, max = Infinity) {
  const seen = new Set()
  const out = []
  for (const item of list ?? []) {
    const text = String(item ?? '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

/** Stable short hash (FNV-1a) for file names / dedupe keys. */
export function shortHash(value, length = 8) {
  let hash = 0x811c9dc5
  const text = String(value ?? '')
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(length, '0').slice(0, length)
}

export function dateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function timeStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${dateStamp(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function uniqueFileStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${dateStamp(date).replace(/-/g, '')}_${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}`
}

/** Extract a BV id from a URL or arbitrary text. */
export function extractBvid(value) {
  const match = /(BV[0-9A-Za-z]{10})/.exec(String(value ?? ''))
  return match ? match[1] : null
}

export function isBilibiliVideoUrl(value) {
  const url = String(value ?? '')
  return /(?:^|\/\/|\.)bilibili\.com\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)/i.test(url)
}

export function isBilibiliNonVideoPage(value) {
  const url = String(value ?? '')
  return (
    /bilibili\.com\/(?:search|space|live|bangumi\/media|read|cheese|audio|account|message)/i.test(url) ||
    /(?:search|space|live|message)\.bilibili\.com/i.test(url) ||
    /^https?:\/\/(?:www\.|m\.)?bilibili\.com\/?(?:[?#].*)?$/i.test(url)
  )
}

/** Robust JSON extraction used for both classification and metadata. */
export function parseJson(text) {
  if (!text) return null
  const raw = String(text).trim()
  try {
    return JSON.parse(raw)
  } catch {
    /* keep trying */
  }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      /* keep trying */
    }
  }
  const object = raw.match(/\{[\s\S]*\}/)
  if (!object) return null
  const candidate = object[0]
  try {
    return JSON.parse(candidate)
  } catch {
    /* keep trying */
  }
  try {
    const fixed = candidate
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
      .replace(/:\s*'([^']*)'/g, ':"$1"')
    return JSON.parse(fixed)
  } catch {
    return null
  }
}

/** Markdown body without its first H1 (for embedding in manuals). */
export function stripFirstH1(markdown) {
  return String(markdown ?? '')
    .replace(/^\s*#\s+[^\n]*\n+/, '')
    .trim()
}

export function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
