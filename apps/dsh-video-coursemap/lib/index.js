/**
 * dsh-video-coursemap — 2.1.0 host plugin entry.
 *
 * Flow: foreground browser → stable new video → classify → fetch Bilibili
 * content → summarize → per-video Word + subject manual + global overview →
 * fresh DSH session (present + memory) → durable state.
 *
 * macOS detection is delegated to ./browser.js (Tabbit exact, Chromium
 * History approximate, AppleScript best effort, manual fallback).
 * @module dsh-video-coursemap
 */

import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { resolveConfig, summarizeConfig } from './config.js'
import {
  addKeywords,
  allVideos,
  atomicWrite,
  ensureLayout,
  ensureSubject,
  formatUpdatedAt,
  isSeen,
  loadState,
  markSeen,
  noteFileName,
  pathsFor,
  readIfExists,
  saveState,
  subjectNames,
  subjectVideos,
  upsertVideo,
} from './state.js'
import {
  browserDiagnostics,
  detectOnce,
  finishTabbit,
} from './browser.js'
import { fetchVideoContent, viewVideo } from './bilibili.js'
import { classify, fallbackClassify, titleKeywords } from './classify.js'
import { digestBullets, generateSummary } from './summarize.js'
import {
  buildManualMeta,
  buildOverviewMeta,
  buildVideoMeta,
  manualMarkdownPath,
  renderOverview,
  renderSubjectManual,
  renderVideoNote,
} from './manual.js'
import { convertToDocx, findPython, writeMeta } from './docx.js'
import { deliverToNewSession } from './deliver.js'
import { matchSubject } from './state.js'
import {
  cleanBrowserTitle,
  dateStamp,
  extractBvid,
  normalizeTitle,
  sanitizeFileName,
  sanitizeSubject,
  sleep,
  timeStamp,
  uniqueStrings,
} from './util.js'

export const name = 'dsh-video-coursemap'
export const inject = ['llm', 'tools']

const startedAt = Date.now()

function textRender(value) {
  return [{ type: 'text', text: String(value?.message ?? value ?? '') }]
}

function errorText(error) {
  return String(error?.message ?? error ?? '未知错误').slice(0, 800)
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const paths = pathsFor(config)
  const pythonPath = findPython()
  let state = loadState(paths.statePath)
  let running = false
  let pending = null
  let pollTimer = null
  let startupTimer = null
  let lastError = null
  const runtime = {
    startedAt,
    lastObserved: null,
    lastObservedKey: null,
    lastRunAt: 0,
    lastDelivery: null,
    pythonPath,
  }

  try {
    ensureLayout(paths)
  } catch (error) {
    lastError = `输出目录不可写：${errorText(error)}`
    console.error('[dsh-video-coursemap]', lastError)
  }

  function log(event) {
    try {
      if (!existsSync(paths.logsDir)) ensureLayout(paths)
      const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'
      appendFileSync(paths.logPath, line, 'utf8')
      try {
        if (statSync(paths.logPath).size > config.logMaxBytes) {
          renameSync(paths.logPath, paths.logPath + '.1')
        }
      } catch {
        /* rotation is best effort */
      }
    } catch {
      /* logging must never break the poller */
    }
  }

  function recordError(scope, error) {
    lastError = `[${scope}] ${errorText(error)}`
    log({ level: 'error', scope, message: errorText(error) })
    console.error('[dsh-video-coursemap]', lastError)
  }

  function persist() {
    try {
      saveState(paths.statePath, state)
    } catch (error) {
      recordError('state.save', error)
    }
  }

  function writePair({ mdPath, docxPath, metaPath, markdown, meta }) {
    atomicWrite(mdPath, markdown)
    if (metaPath) writeMeta(metaPath, meta)
    convertToDocx({ mdPath, docxPath, metaPath, pythonPath })
    return docxPath
  }

  function writeManual(subject) {
    const videos = subjectVideos(state, subject).map((video) => ({
      ...video,
      markdown: readIfExists(video.noteMd),
    }))
    const markdown = renderSubjectManual(subject, videos, state)
    const meta = buildManualMeta(subject, videos, state)
    const mdPath = manualMarkdownPath(paths, subject)
    const docxPath = join(paths.root, sanitizeSubject(subject), '学习手册.docx')
    writePair({
      mdPath,
      docxPath,
      metaPath: join(paths.manualsDir, `${sanitizeSubject(subject)}.meta.json`),
      markdown,
      meta,
    })
    return docxPath
  }

  function writeOverview() {
    const markdown = renderOverview(state)
    const meta = buildOverviewMeta(state)
    return writePair({
      mdPath: paths.overviewMd,
      docxPath: paths.overviewDocx,
      metaPath: join(paths.stateDir, 'overview.meta.json'),
      markdown,
      meta,
    })
  }

  function rebuildAll({ subject = null } = {}) {
    const targets = subject ? [subject] : subjectNames(state)
    const built = []
    for (const name of targets) {
      if (!state.subjects[name]) continue
      built.push({ subject: name, docx: writeManual(name) })
    }
    const overview = writeOverview()
    return { subjects: built, overview }
  }

  async function writeNote(record, summary, content) {
    const meta = buildVideoMeta(record, content)
    const markdown = renderVideoNote(summary, meta)
    const docxPath = record.noteDocx
    writePair({
      mdPath: record.noteMd,
      docxPath,
      metaPath: record.noteMeta,
      markdown,
      meta,
    })
    return { docxPath, meta }
  }

  async function processVideo(observation, options = {}) {
    if (running) return { ok: false, skipped: 'busy', message: '已有任务在处理中' }
    running = true
    try {
      if (!options.force && isSeen(state, observation)) {
        return { ok: true, skipped: 'seen', message: '该视频已处理过，保持静默' }
      }
      const title = cleanBrowserTitle(observation.title) || String(observation.title ?? '')
      if (!title || title.length < config.titleMinLen) {
        return { ok: false, skipped: 'short-title', message: '标题太短，跳过' }
      }
      const classification = await classify(ctx, config, {
        title,
        existingSubjects: state.subjects,
      })
      log({ level: 'info', scope: 'classify', title, result: classification })
      if (!classification.isCourse) {
        markSeen(state, { ...observation, title }, 'non-course', {
          subject: classification.subject,
        })
        state.updatedAt = Date.now()
        persist()
        return {
          ok: true,
          skipped: 'non-course',
          message: `非课程内容，已静默忽略：${title}`,
        }
      }

      let content = null
      if (config.fetchContent) {
        try {
          content = await fetchVideoContent(
            { bvid: observation.bvid, title: classification.title || title },
            config,
          )
          log({
            level: 'info',
            scope: 'content',
            bvid: content?.bvid ?? null,
            tags: content?.tags?.length ?? 0,
            danmaku: content?.danmaku?.length ?? 0,
            comments: content?.comments?.length ?? 0,
            subtitle: content?.transcript?.length ?? 0,
          })
        } catch (error) {
          recordError('bilibili', error)
          content = null
        }
      }

      let subject = classification.subject
      let keywords = uniqueStrings(
        [...(classification.keywords ?? []), ...(content?.tags ?? [])],
        10,
      )
      if (
        content &&
        (subject === '未分类' || classification.confidence < 0.5) &&
        (content.tags?.length || content.desc)
      ) {
        const fallback = fallbackClassify(classification.title || title, {
          tags: content.tags,
          desc: content.desc,
        })
        if (fallback.isCourse) {
          subject = matchSubject(fallback.subject, state.subjects) ?? fallback.subject
          keywords = uniqueStrings([...keywords, ...fallback.keywords], 10)
        }
      }
      subject = matchSubject(subject, state.subjects) ?? sanitizeSubject(subject)
      if (!subject) subject = '未分类'

      const finalTitle = String(classification.title || content?.title || title).trim()
      const summary = await generateSummary(ctx, config, {
        title: finalTitle,
        subject,
        keywords,
        content,
      })

      const record = {
        bvid: content?.bvid ?? observation.bvid ?? extractBvid(observation.url ?? '') ?? null,
        title: finalTitle,
        subject,
        url: content?.url ?? observation.url ?? '',
        owner: content?.owner ?? '',
        tags: content?.tags ?? [],
        keywords,
        coverage: content?.coverage ?? null,
        date: dateStamp(new Date()),
        addedAt: Date.now(),
        noteMd: '',
        noteMeta: '',
        noteDocx: '',
        manualDocx: '',
      }
      const idPart = record.bvid || `title-${sanitizeFileName(finalTitle, 40)}`
      const noteBase = sanitizeFileName(idPart, 64)
      record.noteMd = join(paths.notesDir, `${noteBase}.md`)
      record.noteMeta = join(paths.notesDir, `${noteBase}.meta.json`)
      record.noteDocx = join(paths.videosDir, noteFileName(record))
      record.manualDocx = join(paths.root, sanitizeSubject(subject), '学习手册.docx')

      const upserted = upsertVideo(state, record)
      const { video } = upserted
      const { isNewSubject, isNewVideo } = upserted
      addKeywords(state, subject, keywords)
      state.lastObservation = {
        source: observation.source ?? 'unknown',
        title: finalTitle,
        url: record.url,
        at: Date.now(),
      }
      state.updatedAt = Date.now()
      persist()

      let noteError = null
      let manualDocx = record.manualDocx
      try {
        await writeNote(video, summary, content)
        manualDocx = writeManual(subject)
        writeOverview()
      } catch (error) {
        noteError = errorText(error)
        recordError('docx', error)
      }

      let delivery = null
      const alreadyDelivered = Boolean(video.delivered?.ok)
      const noteDocxExists = existsSync(record.noteDocx)
      const safeManualDocx = manualDocx && existsSync(manualDocx) ? manualDocx : null
      if (
        config.delivery.newSession &&
        noteDocxExists &&
        options.deliver !== false &&
        (!alreadyDelivered || options.redeliver === true)
      ) {
        try {
          delivery = await deliverToNewSession(ctx, config, {
            video,
            noteDocx: record.noteDocx,
            manualDocx: safeManualDocx,
            bullets: digestBullets(summary, 6),
          })
          if (delivery.ok) {
            video.delivered = { ok: true, sessionId: delivery.sessionId, at: Date.now() }
            state.lastDelivery = { ok: true, sessionId: delivery.sessionId, at: Date.now() }
            runtime.lastDelivery = state.lastDelivery
          } else {
            video.delivered = { ok: false, error: delivery.error, at: Date.now() }
            state.lastDelivery = { ok: false, error: delivery.error, at: Date.now() }
            lastError = delivery.error ?? lastError
          }
        } catch (error) {
          delivery = { ok: false, error: errorText(error) }
          recordError('delivery', error)
        }
      }

      markSeen(state, { ...observation, title: finalTitle, bvid: record.bvid }, 'course', {
        subject,
      })
      state.lastRunAt = Date.now()
      runtime.lastRunAt = state.lastRunAt
      state.updatedAt = Date.now()
      persist()
      log({
        level: 'info',
        scope: 'processed',
        title: finalTitle,
        subject,
        isNewSubject,
        noteDocx: record.noteDocx,
        sessionId: delivery?.sessionId ?? null,
      })
      return {
        ok: true,
        skipped: null,
        subject,
        isNewSubject,
        isNewVideo,
        noteDocx: record.noteDocx,
        manualDocx: safeManualDocx ?? '',
        sessionId: delivery?.sessionId ?? null,
        deliveryError: delivery && delivery.ok === false ? delivery.error : null,
        docxError: noteError,
        message: [
          `已生成知识笔记：${finalTitle}`,
          `学科：${subject}${isNewSubject ? '（新学科，已创建学习手册）' : '（已更新学习手册）'}`,
          `视频笔记：${record.noteDocx}`,
          `学科手册：${safeManualDocx ?? '（生成失败）'}`,
          delivery?.ok ? `已交付到新会话：${delivery.sessionId}` : null,
          delivery && !delivery.ok ? `新会话交付失败：${delivery.error}` : null,
          noteError ? `Word 生成失败：${noteError}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      }
    } catch (error) {
      recordError('process', error)
      return { ok: false, skipped: 'error', message: `处理失败：${errorText(error)}` }
    } finally {
      running = false
    }
  }

  async function observeOnce() {
    if (!config.enabled || running) return null
    let observation = null
    try {
      observation = await detectOnce(config)
    } catch (error) {
      recordError('detect', error)
      return null
    }
    if (!observation) {
      pending = null
      return null
    }
    runtime.lastObserved = observation
    const key = observation.bvid || normalizeTitle(observation.title)
    if (runtime.lastObservedKey !== key) {
      runtime.lastObservedKey = key
      log({ level: 'info', scope: 'observe', source: observation.source, title: observation.title, url: observation.url })
    }
    if (isSeen(state, observation)) {
      pending = null
      return null
    }
    if (!pending || pending.key !== key) {
      pending = { key, observation, count: 1 }
    } else {
      pending.count += 1
    }
    if (pending.count < config.stablePolls) return null
    const ready = pending.observation
    pending = null
    return processVideo(ready, { deliver: true })
  }

  function resolveManualObservation(args) {
    const url = String(args?.url ?? '').trim()
    const title = String(args?.title ?? '').trim()
    const bvid = extractBvid(url || title)
    if (!title && !bvid) return null
    if (!title && bvid) {
      return { source: 'manual', title: '', url: url || `https://www.bilibili.com/video/${bvid}`, bvid, at: Date.now() }
    }
    return {
      source: 'manual',
      title: cleanBrowserTitle(title),
      url: url || (bvid ? `https://www.bilibili.com/video/${bvid}` : ''),
      bvid,
      at: Date.now(),
    }
  }

  // ── tools ────────────────────────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'course_map_status',
        description:
          '查看「视频课程知识地图 Agent」状态：启用、输出目录、检测后端、最近观察、学科/视频数、最近交付会话与错误。',
        parameters: { type: 'object', properties: {} },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              enabled: { type: 'boolean' },
              outputDir: { type: 'string' },
              backend: { type: 'string' },
              frontApp: { type: 'string' },
              lastTitle: { type: 'string' },
              lastRunAt: { type: 'integer' },
              subjects: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    subject: { type: 'string' },
                    videos: { type: 'integer' },
                  },
                  required: ['subject', 'videos'],
                },
              },
              videoCount: { type: 'integer' },
              lastDeliverySession: { type: 'string' },
              lastDeliveryAt: { type: 'integer' },
              lastError: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['ok', 'message'],
          },
          render: (_args, value) => textRender(value),
        },
        async execute() {
          const diagnostics = await browserDiagnostics(config).catch(() => ({
            frontApp: '（未知）',
            backend: config.browser.backend,
          }))
          const subjects = Object.entries(state.subjects).map(([subject, data]) => ({
            subject,
            videos: data.videos?.length ?? 0,
          }))
          const last = state.lastDelivery ?? runtime.lastDelivery
          const message = [
            '视频课程知识地图 Agent 状态：',
            `- 启用：${config.enabled}`,
            `- 输出目录：${config.outputDir}`,
            `- 检测后端：${diagnostics.backend}（前台：${diagnostics.frontApp}）`,
            `- 学科数：${subjects.length}，视频数：${Object.keys(state.videos).length}`,
            ...subjects.map((row) => `  · ${row.subject}（${row.videos} 个视频）`),
            `- 最近观察：${runtime.lastObserved?.title ?? state.lastObservation?.title ?? '（无）'}`,
            `- 最近交付：${last?.sessionId ?? '（无）'}`,
            `- 最近错误：${lastError ?? '（无）'}`,
            `- Python：${pythonPath ?? '（未找到 python-docx）'}`,
            `- 配置：${JSON.stringify(summarizeConfig(config))}`,
          ].join('\n')
          return {
            ok: true,
            enabled: config.enabled,
            outputDir: config.outputDir,
            backend: config.browser.backend,
            frontApp: diagnostics.frontApp ?? '（未知）',
            lastTitle: runtime.lastObserved?.title ?? state.lastObservation?.title ?? '',
            lastRunAt: state.lastRunAt ?? 0,
            subjects,
            videoCount: Object.keys(state.videos).length,
            lastDeliverySession: last?.sessionId ?? '',
            lastDeliveryAt: Number(last?.at ?? 0),
            lastError: lastError ?? '',
            message,
          }
        },
      }),
    'dsh-video-coursemap: status tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'course_map_scan',
        description:
          '立即检测当前 B 站视频或处理指定 video/title：生成 Word 知识笔记、更新学科手册，并可自动新建会话交付。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '可选：直接指定视频标题' },
            url: { type: 'string', description: '可选：直接指定 B 站视频 URL' },
            force: { type: 'boolean', description: '已处理过的视频也重新生成（默认 false）' },
            deliver: { type: 'boolean', description: '是否新建会话交付（force 时默认 false）' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              subject: { type: 'string' },
              isNewSubject: { type: 'boolean' },
              noteDocx: { type: 'string' },
              manualDocx: { type: 'string' },
              sessionId: { type: 'string' },
              error: { type: 'string' },
            },
            required: ['ok', 'message'],
          },
          render: (_args, value) => textRender(value),
        },
        async execute(args = {}) {
          if (!config.enabled) return { ok: false, message: 'Agent 未启用（config.enabled=false）' }
          let observation = null
          if (args.title || args.url) {
            observation = resolveManualObservation(args)
          } else {
            observation = await detectOnce(config).catch(() => null)
            if (!observation) {
              return {
                ok: false,
                message: `未检测到 B 站视频（前台：${(await browserDiagnostics(config)).frontApp}；可用 title/url 手动指定）`,
              }
            }
          }
          if (!observation) return { ok: false, message: '未提供有效的标题或 URL' }
          const waitStart = Date.now()
          while (running && Date.now() - waitStart < 90000) await sleep(500)
          if (observation.bvid && !observation.title) {
            try {
              const view = await viewVideo(observation.bvid)
              if (view?.title) observation.title = view.title
            } catch {
              /* fall back below */
            }
          }
          if (!observation.title) observation.title = observation.url || observation.bvid || ''
          const result = await processVideo(observation, {
            deliver: args.deliver ?? !args.force,
            force: args.force === true,
            redeliver: args.force === true && args.deliver === true,
          })
          return {
            ok: Boolean(result.ok),
            message: result.message ?? '',
            subject: result.subject ?? '',
            isNewSubject: Boolean(result.isNewSubject),
            noteDocx: result.noteDocx ?? '',
            manualDocx: result.manualDocx ?? '',
            sessionId: result.sessionId ?? '',
            error: result.ok ? '' : result.message ?? '',
          }
        },
      }),
    'dsh-video-coursemap: scan tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'course_map_deliver',
        description:
          '把最近一次（或指定 bvid）的视频 Word 笔记重新交付到一个新的 DSH 会话；用于自动交付失败后的重试。',
        parameters: {
          type: 'object',
          properties: {
            bvid: { type: 'string', description: '可选：指定视频 BV 号；缺省取最近一个视频' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              sessionId: { type: 'string' },
              error: { type: 'string' },
            },
            required: ['ok', 'message'],
          },
          render: (_args, value) => textRender(value),
        },
        async execute(args = {}) {
          const videos = allVideos(state)
          const target = args.bvid
            ? videos.find((video) => video.bvid === args.bvid)
            : videos[0]
          if (!target) return { ok: false, message: '还没有已生成的视频笔记' }
          if (!target.noteDocx || !existsSync(target.noteDocx)) {
            return { ok: false, message: `未找到 Word 文件：${target.noteDocx ?? '（无）'}` }
          }
          const manualDocx =
            target.manualDocx && existsSync(target.manualDocx) ? target.manualDocx : null
          const delivery = await deliverToNewSession(ctx, config, {
            video: target,
            noteDocx: target.noteDocx,
            manualDocx,
            bullets: [],
          })
          if (delivery.ok) {
            target.delivered = { ok: true, sessionId: delivery.sessionId, at: Date.now() }
            state.lastDelivery = { ok: true, sessionId: delivery.sessionId, at: Date.now() }
            persist()
            return {
              ok: true,
              sessionId: delivery.sessionId,
              message: `已创建交付会话 ${delivery.sessionId}：${target.title}`,
            }
          }
          return { ok: false, message: delivery.error ?? '交付失败', error: delivery.error ?? '' }
        },
      }),
    'dsh-video-coursemap: deliver tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'course_map_rebuild',
        description: '从已保存的 Markdown 源重建 Word：指定学科手册或全量重建 + 课程总览。',
        parameters: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: '可选：只重建某个学科；缺省全量' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              overview: { type: 'string' },
              subjects: { type: 'array', items: { type: 'string' } },
              error: { type: 'string' },
            },
            required: ['ok', 'message'],
          },
          render: (_args, value) => textRender(value),
        },
        async execute(args = {}) {
          try {
            const built = rebuildAll({ subject: args.subject ? sanitizeSubject(args.subject) : null })
            persist()
            return {
              ok: true,
              message: `已重建 ${built.subjects.length} 个学科手册与课程总览。`,
              overview: built.overview,
              subjects: built.subjects.map((row) => row.subject),
            }
          } catch (error) {
            recordError('rebuild', error)
            return { ok: false, message: `重建失败：${errorText(error)}`, error: errorText(error) }
          }
        },
      }),
    'dsh-video-coursemap: rebuild tool',
  )

  // ── startup + polling ───────────────────────────────────────────────────
  if (config.rebuildOnStartup && (subjectNames(state).length > 0 || Object.keys(state.videos).length > 0)) {
    startupTimer = setTimeout(() => {
      try {
        rebuildAll()
        log({ level: 'info', scope: 'startup-rebuild' })
      } catch (error) {
        recordError('startup-rebuild', error)
      }
    }, 1500)
    startupTimer.unref?.()
  }

  ctx.effect(() => {
    pollTimer = setInterval(() => {
      observeOnce().catch((error) => recordError('poll', error))
    }, config.pollIntervalMs)
    pollTimer.unref?.()
    return () => {
      if (pollTimer) clearInterval(pollTimer)
      if (startupTimer) clearTimeout(startupTimer)
    }
  }, 'dsh-video-coursemap: poll timer')

  ctx.effect(
    () => () => {
      finishTabbit({ task: config.browser.tabbitTask }).catch(() => {})
    },
    'dsh-video-coursemap: tabbit cleanup',
  )

  log({
    level: 'info',
    scope: 'startup',
    outputDir: config.outputDir,
    backend: config.browser.backend,
    pollIntervalMs: config.pollIntervalMs,
    python: pythonPath,
    subjects: subjectNames(state),
  })
  console.log(
    `[dsh-video-coursemap] 2.1.0 已启动：每 ${config.pollIntervalMs}ms 检测 ${config.browser.backend}，输出 ${config.outputDir}`,
  )
}
