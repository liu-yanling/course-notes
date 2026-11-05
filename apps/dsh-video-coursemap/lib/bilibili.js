/**
 * dsh-video-coursemap — Bilibili content acquisition.
 *
 * Content is intentionally best-effort: Bilibili often ships no machine
 * subtitle, and the AI conclusion endpoint requires a logged-in account.
 * We still gather the description, chapters, tags, danmaku and hot comments,
 * and report exactly what was available in the generated note.
 * @module dsh-video-coursemap/bilibili
 */

import {
  BILI_UA,
  bigramSimilarity,
  decodeXml,
  extractBvid,
  stripHtml,
  uniqueStrings,
} from './util.js'

const BILI_REFERER = 'https://www.bilibili.com/'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let cachedBuvid3 = null

async function getBuvid3() {
  if (cachedBuvid3 !== null) return cachedBuvid3
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': BILI_UA },
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json()
    cachedBuvid3 = String(data?.data?.b_3 ?? '')
  } catch {
    cachedBuvid3 = ''
  }
  return cachedBuvid3
}

async function biliFetch(url, { json = true, timeoutMs = 10000, retries = 2 } = {}) {
  const buvid3 = await getBuvid3()
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': BILI_UA,
          Referer: BILI_REFERER,
          Accept: 'application/json, text/plain, */*',
          ...(buvid3 ? { Cookie: `buvid3=${buvid3}` } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 412) throw new Error('HTTP 412 risk control')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      return json ? JSON.parse(text) : text
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(1200 * (attempt + 1))
    }
  }
  throw lastError ?? new Error('bilibili request failed')
}

/** Search a video by title; returns null when nothing is similar enough. */
export async function searchVideo(title, { minSimilarity = 0.5 } = {}) {
  const keyword = String(title ?? '').trim()
  if (!keyword) return null
  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' +
    encodeURIComponent(keyword)
  const data = await biliFetch(url)
  if (data?.code !== 0) throw new Error(`bili search code ${data?.code}`)
  const results = (data?.data?.result ?? []).filter((row) => row?.bvid)
  let best = null
  let bestScore = 0
  for (const row of results.slice(0, 10)) {
    const clean = stripHtml(row.title)
    const score = bigramSimilarity(keyword, clean)
    if (score > bestScore) {
      bestScore = score
      best = { row, clean }
    }
  }
  if (!best || bestScore < minSimilarity) return null
  return {
    bvid: best.row.bvid,
    aid: best.row.aid,
    title: best.clean,
    desc: stripHtml(best.row.description ?? ''),
    tags: String(best.row.tag ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
  }
}

export async function viewVideo(bvid) {
  const data = await biliFetch(
    'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid),
  )
  if (data?.code !== 0) throw new Error(`bili view code ${data?.code}`)
  return data.data ?? null
}

export async function viewVideoByAid(aid) {
  const data = await biliFetch(
    'https://api.bilibili.com/x/web-interface/view?aid=' + encodeURIComponent(aid),
  )
  if (data?.code !== 0) throw new Error(`bili view code ${data?.code}`)
  return data.data ?? null
}

export async function fetchTags(bvid) {
  try {
    const data = await biliFetch(
      'https://api.bilibili.com/x/tag/archive/tags?bvid=' + encodeURIComponent(bvid),
    )
    if (data?.code !== 0) return []
    return uniqueStrings((data.data ?? []).map((tag) => tag?.tag_name), 20)
  } catch {
    return []
  }
}

/** Parse every danmaku entry with its timeline position. */
export function parseDanmaku(xml) {
  const text = String(xml ?? '')
  const rows = []
  const re = /<d([^>]*)>([\s\S]*?)<\/d>/g
  let match
  while ((match = re.exec(text)) !== null) {
    const attrs = match[1] ?? ''
    const body = decodeXml(match[2]).trim()
    if (!body) continue
    if (body.startsWith('[') && body.endsWith(']')) continue // advanced JSON danmaku
    const p = /p="([^"]*)"/.exec(attrs)?.[1] ?? ''
    const time = Number.parseFloat(String(p).split(',')[0])
    rows.push({ text: body, time: Number.isFinite(time) ? time : 0 })
  }
  return rows
}

const DANMAKU_NOISE = new Set([
  '来了',
  '来了来了',
  '打卡',
  '哈哈',
  '哈哈哈',
  '哈哈哈哈',
  '666',
  '6666',
  '？？？',
  '?',
  '？',
  '1',
  'awsl',
  '好家伙',
  '前排',
  '空降',
  '老师好',
  '大家好',
  '沙发',
  '火钳刘明',
])

function isNoise(text) {
  const compact = String(text ?? '').trim()
  if (!compact) return true
  if (DANMAKU_NOISE.has(compact)) return true
  if (/^[\p{P}\p{S}\d\s]+$/u.test(compact)) return true
  if (/^(哈|啊|哦|嗯|呃|哇)+$/u.test(compact)) return true
  return false
}

/** Stratified sample across the timeline, preferring substantive comments. */
export function sampleDanmaku(rows, max = 120) {
  const cleaned = rows
    .map((row) => ({ text: String(row.text ?? '').trim(), time: Number(row.time) || 0 }))
    .filter((row) => !isNoise(row.text))
  if (cleaned.length <= max) return uniqueStrings(cleaned.map((row) => row.text), max)
  const end = Math.max(...cleaned.map((row) => row.time), 1)
  const buckets = Array.from({ length: 10 }, () => [])
  for (const row of cleaned) {
    const index = Math.min(9, Math.max(0, Math.floor((row.time / end) * 10)))
    buckets[index].push(row)
  }
  const perBucket = Math.max(1, Math.ceil(max / 10))
  const picked = []
  for (const bucket of buckets) {
    const ranked = [...bucket].sort((a, b) => b.text.length - a.text.length)
    for (const row of ranked.slice(0, perBucket)) picked.push(row)
  }
  picked.sort((a, b) => a.time - b.time)
  const texts = uniqueStrings(picked.map((row) => row.text), max)
  if (texts.length >= max) return texts
  // Fill from the full pool if a bucket was sparse.
  for (const row of cleaned) {
    if (texts.length >= max) break
    if (!texts.includes(row.text)) texts.push(row.text)
  }
  return texts
}

export async function fetchDanmaku(cid, max = 120) {
  if (!cid) return []
  const xml = await biliFetch('https://comment.bilibili.com/' + encodeURIComponent(cid) + '.xml', {
    json: false,
    timeoutMs: 12000,
  })
  return sampleDanmaku(parseDanmaku(xml), max)
}

function extractComments(payload) {
  const replies = payload?.data?.replies ?? payload?.data?.top_replies ?? []
  const out = []
  for (const reply of replies) {
    const message = String(reply?.content?.message ?? '').trim()
    if (!message) continue
    out.push({
      text: message,
      like: Number(reply?.like ?? 0),
      author: String(reply?.member?.uname ?? ''),
    })
  }
  return out
}

export async function fetchComments(aid, max = 20) {
  if (!aid) return []
  const modes = [
    `https://api.bilibili.com/x/v2/reply?type=1&oid=${encodeURIComponent(aid)}&sort=2&ps=20&pn=1`,
    `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${encodeURIComponent(aid)}&mode=3&next=0`,
  ]
  let replies = []
  for (const url of modes) {
    try {
      const data = await biliFetch(url)
      if (data?.code === 0) {
        replies = extractComments(data)
        if (replies.length > 0) break
      }
    } catch {
      /* try the next endpoint */
    }
  }
  const seen = new Set()
  return replies
    .filter((row) => {
      if (seen.has(row.text)) return false
      seen.add(row.text)
      return true
    })
    .sort((a, b) => b.like - a.like)
    .slice(0, max)
}

export async function fetchSubtitle(view) {
  const candidates = []
  for (const item of view?.subtitle?.list ?? []) {
    if (item?.subtitle_url) candidates.push(item.subtitle_url)
  }
  for (const item of view?.subtitle?.subtitles ?? []) {
    if (item?.url) candidates.push(item.url)
  }
  let url = candidates[0]
  if (!url) return ''
  if (url.startsWith('//')) url = 'https:' + url
  try {
    const data = await biliFetch(url, { timeoutMs: 12000 })
    return uniqueStrings(
      (data?.body ?? []).map((row) => String(row?.content ?? '').trim()),
      2000,
    ).join(' ')
  } catch {
    return ''
  }
}

export async function fetchPlayerSubtitle(bvid, cid) {
  try {
    const data = await biliFetch(
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`,
    )
    if (data?.code !== 0) return ''
    const list = data?.data?.subtitle?.subtitles ?? []
    if (list.length === 0) return ''
    let url = list[0]?.subtitle_url ?? list[0]?.url ?? ''
    if (!url) return ''
    if (url.startsWith('//')) url = 'https:' + url
    const body = await biliFetch(url, { timeoutMs: 12000 })
    return uniqueStrings(
      (body?.body ?? []).map((row) => String(row?.content ?? '').trim()),
      2000,
    ).join(' ')
  } catch {
    return ''
  }
}

/**
 * Fetch everything we can use for one video.
 * @param {{bvid?: string|null, title: string}} input
 */
export async function fetchVideoContent(input, config = {}) {
  const title = String(input?.title ?? '').trim()
  let bvid = input?.bvid || extractBvid(title)
  let searchResult = null
  if (!bvid) {
    searchResult = await searchVideo(title)
    bvid = searchResult?.bvid ?? null
  }
  if (!bvid) {
    return {
      bvid: null,
      title,
      url: '',
      desc: '',
      tags: [],
      pages: [],
      stat: {},
      owner: '',
      transcript: '',
      danmaku: [],
      comments: [],
      coverage: { desc: false, tags: 0, chapters: 0, subtitle: 0, danmaku: 0, comments: 0 },
      source: 'title-only',
    }
  }

  let view = null
  try {
    view = await viewVideo(bvid)
  } catch {
    try {
      view = searchResult ?? null
    } catch {
      view = null
    }
  }
  if (!view) {
    return {
      bvid,
      title: searchResult?.title ?? title,
      url: `https://www.bilibili.com/video/${bvid}`,
      desc: searchResult?.desc ?? '',
      tags: searchResult?.tags ?? [],
      pages: [],
      stat: {},
      owner: '',
      transcript: '',
      danmaku: [],
      comments: [],
      coverage: { desc: false, tags: 0, chapters: 0, subtitle: 0, danmaku: 0, comments: 0 },
      source: 'search-only',
    }
  }

  const aid = view.aid ?? searchResult?.aid ?? null
  const cid = view.cid ?? view.pages?.[0]?.cid ?? null
  const tags = await fetchTags(bvid)
  const [danmaku, comments] = await Promise.all([
    fetchDanmaku(cid, config.summary?.maxDanmaku ?? 120).catch(() => []),
    fetchComments(aid, config.summary?.maxComments ?? 20).catch(() => []),
  ])
  let transcript = ''
  try {
    transcript = await fetchSubtitle(view)
    if (!transcript) transcript = await fetchPlayerSubtitle(bvid, cid)
  } catch {
    transcript = ''
  }
  const pages = (view.pages ?? []).map((page) => ({
    page: Number(page.page ?? 0),
    title: String(page.part ?? ''),
    duration: Number(page.duration ?? 0),
  }))
  return {
    bvid,
    aid,
    cid,
    title: stripHtml(view.title ?? searchResult?.title ?? title),
    url: `https://www.bilibili.com/video/${bvid}`,
    desc: String(view.desc ?? searchResult?.desc ?? '').trim(),
    tags: uniqueStrings([...(searchResult?.tags ?? []), ...tags], 20),
    pages,
    stat: view.stat ?? {},
    owner: String(view.owner?.name ?? ''),
    pic: String(view.pic ?? '').startsWith('//') ? 'https:' + view.pic : String(view.pic ?? ''),
    duration: Number(view.duration ?? 0),
    transcript,
    danmaku,
    comments,
    coverage: {
      desc: Boolean(String(view.desc ?? searchResult?.desc ?? '').trim()),
      tags: uniqueStrings([...(searchResult?.tags ?? []), ...tags], 20).length,
      chapters: pages.length,
      subtitle: transcript.length,
      danmaku: danmaku.length,
      comments: comments.length,
    },
    source: 'bilibili',
  }
}

/** Human-readable coverage line for the Word note / prompt. */
export function coverageText(content) {
  if (!content) return '未抓取到 B 站内容'
  const parts = []
  if (content.desc) parts.push('视频简介')
  if (content.pages?.length) parts.push(`分P章节 ${content.pages.length} 个`)
  if (content.tags?.length) parts.push(`标签 ${content.tags.length} 个`)
  if (content.transcript) parts.push(`字幕 ${content.transcript.length} 字`)
  if (content.danmaku?.length) parts.push(`弹幕 ${content.danmaku.length} 条`)
  if (content.comments?.length) parts.push(`热评 ${content.comments.length} 条`)
  return parts.length ? parts.join(' · ') : '仅视频标题'
}
