/**
 * Standalone course pipeline: detect → classify → fetch → summarize → Word.
 *
 * Reuses the pure engine modules from apps/dsh-video-coursemap/lib. No DSH
 * services are involved; the only external pieces are Bilibili, the configured
 * LLM, and the DSH-bundled Python for .docx.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { fetchVideoContent, viewVideo } from '../apps/dsh-video-coursemap/lib/bilibili.js'
import { classify, fallbackClassify } from '../apps/dsh-video-coursemap/lib/classify.js'
import { generateSummary } from '../apps/dsh-video-coursemap/lib/summarize.js'
import {
  addKeywords,
  atomicWrite,
  isSeen,
  markSeen,
  noteFileName,
  readIfExists,
  saveState,
  subjectVideos,
  upsertVideo,
} from '../apps/dsh-video-coursemap/lib/state.js'
import {
  buildManualMeta,
  buildOverviewMeta,
  buildVideoMeta,
  manualMarkdownPath,
  renderOverview,
  renderSubjectManual,
  renderVideoNote,
} from '../apps/dsh-video-coursemap/lib/manual.js'
import { convertToDocx, writeMeta } from '../apps/dsh-video-coursemap/lib/docx.js'
import { createLlmBridge } from './llm.mjs'
import { buildLocalSummary } from './local-summary.mjs'
import {
  dateStamp,
  extractBvid,
  sanitizeFileName,
  sanitizeSubject,
  uniqueStrings,
} from '../apps/dsh-video-coursemap/lib/util.js'

function errorText(error) {
  return String(error?.message ?? error ?? '未知错误').slice(0, 600)
}

function writePair({ mdPath, docxPath, metaPath, markdown, meta }) {
  atomicWrite(mdPath, markdown)
  if (metaPath) writeMeta(metaPath, meta)
  convertToDocx({ mdPath, docxPath, metaPath })
  return docxPath
}

export function createPipeline({ config, engine, state, paths, emit, save = saveState }) {
  let currentBridge = null
  let aborted = false
  let running = false

  function writeManual(subject) {
    const videos = subjectVideos(state, subject).map((video) => ({
      ...video,
      markdown: readIfExists(video.noteMd),
    }))
    const markdown = renderSubjectManual(subject, videos, state)
    const meta = buildManualMeta(subject, videos, state)
    return writePair({
      mdPath: manualMarkdownPath(paths, subject),
      docxPath: join(paths.root, sanitizeSubject(subject), '学习手册.docx'),
      metaPath: join(paths.manualsDir, sanitizeSubject(subject) + '.meta.json'),
      markdown,
      meta,
    })
  }

  function writeOverview() {
    return writePair({
      mdPath: paths.overviewMd,
      docxPath: paths.overviewDocx,
      metaPath: join(paths.stateDir, 'overview.meta.json'),
      markdown: renderOverview(state),
      meta: buildOverviewMeta(state),
    })
  }

  async function resolveObservation(observation) {
    if (!observation.bvid && observation.url) observation.bvid = extractBvid(observation.url) || null
    if (observation?.bvid && !observation.title) {
      try {
        const view = await viewVideo(observation.bvid)
        if (view?.title) observation.title = view.title
      } catch {
        /* fall back to URL below */
      }
    }
    if (!observation.title) observation.title = observation.url || observation.bvid || ''
    return observation
  }

  async function runTask(observation, { force = false, manual = false } = {}) {
    if (running) {
      const error = new Error('已有总结任务正在运行')
      error.code = 'BUSY'
      throw error
    }
    running = true
    aborted = false
    const taskId = 'task-' + randomUUID()
    const startedAt = Date.now()
    const stage = (name, progress, message) => {
      emit({ type: 'task', taskId, stage: name, progress, title: observation.title, message, at: Date.now() })
    }
    const bridge = createLlmBridge(config)
    currentBridge = bridge
    try {
      observation = await resolveObservation(observation)
      if (!force && isSeen(state, observation)) {
        emit({
          type: 'task',
          taskId,
          stage: 'done',
          progress: 100,
          title: observation.title,
          message: '该视频已处理过，保持静默',
          skipped: 'seen',
          at: Date.now(),
        })
        return { ok: true, skipped: 'seen', taskId }
      }
      stage('classify', 12, '正在判断学科与内容类型…')
      let classification = null
      if (config.llm.provider !== 'local') {
        bridge.setOnDelta(null)
        try {
          classification = await classify(bridge.ctx, engine, {
            title: observation.title,
            existingSubjects: state.subjects,
          })
        } catch (error) {
          emit({ type: 'log', level: 'warn', message: 'LLM 分类失败，使用关键词兜底：' + errorText(error) })
        }
      }
      if (!classification) {
        classification = fallbackClassify(observation.title, {})
      }
      if (!classification.isCourse) {
        markSeen(state, { ...observation, title: observation.title }, 'non-course', {
          subject: classification.subject,
        })
        state.updatedAt = Date.now()
        save(paths.statePath, state)
        emit({
          type: 'task',
          taskId,
          stage: 'done',
          progress: 100,
          title: observation.title,
          message: '非课程内容，已静默忽略',
          skipped: 'non-course',
          at: Date.now(),
        })
        return { ok: true, skipped: 'non-course', taskId }
      }

      stage('fetch', 30, '正在抓取视频简介、弹幕与评论…')
      let content = null
      if (config.fetchContent) {
        try {
          content = await fetchVideoContent(
            { bvid: observation.bvid, title: classification.title || observation.title },
            engine,
          )
        } catch (error) {
          emit({ type: 'log', level: 'warn', message: 'B站内容抓取失败，降级为标题总结：' + errorText(error) })
        }
      }

      let subject = classification.subject
      let keywords = uniqueStrings([...(classification.keywords ?? []), ...(content?.tags ?? [])], 10)
      if (
        content &&
        (subject === '未分类' || classification.confidence < 0.5) &&
        (content.tags?.length || content.desc)
      ) {
        const fallback = fallbackClassify(classification.title || observation.title, {
          tags: content.tags,
          desc: content.desc,
        })
        if (fallback.isCourse) {
          subject = fallback.subject
          keywords = uniqueStrings([...keywords, ...fallback.keywords], 10)
        }
      }
      subject = sanitizeSubject(subject)
      const finalTitle = String(classification.title || content?.title || observation.title).trim()

      stage('summarize', 45, '正在生成知识总结…')
      let summary = ''
      if (config.llm.provider === 'local') {
        summary = buildLocalSummary({ title: finalTitle, subject, keywords, content })
        emit({ type: 'task', taskId, stage: 'summarize', progress: 78, title: finalTitle, message: '本地提取完成', at: Date.now() })
      } else {
        bridge.setOnDelta((text) => {
          if (aborted) return
          emit({ type: 'summary:delta', taskId, text, at: Date.now() })
        })
        try {
          summary = await generateSummary(bridge.ctx, engine, {
            title: finalTitle,
            subject,
            keywords,
            content,
          })
          if (String(summary).includes('本次 LLM 总结失败')) {
            throw new Error('LLM 总结失败')
          }
        } catch (error) {
          emit({ type: 'log', level: 'warn', message: 'LLM 总结失败，降级为本地提取：' + errorText(error) })
          summary = buildLocalSummary({ title: finalTitle, subject, keywords, content })
        } finally {
          bridge.setOnDelta(null)
        }
      }
      if (aborted) throw new Error('任务已取消')

      stage('docs', 92, '正在生成 Word 文档…')
      const record = {
        bvid: content?.bvid ?? observation.bvid ?? extractBvid(observation.url ?? '') ?? null,
        title: finalTitle,
        subject,
        url: content?.url ?? observation.url ?? '',
        owner: content?.owner ?? '',
        pic: content?.pic ?? '',
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
      const idPart = record.bvid || 'title-' + sanitizeFileName(finalTitle, 40)
      const noteBase = sanitizeFileName(idPart, 64)
      record.noteMd = join(paths.notesDir, noteBase + '.md')
      record.noteMeta = join(paths.notesDir, noteBase + '.meta.json')
      record.noteDocx = join(paths.videosDir, noteFileName(record))
      record.manualDocx = join(paths.root, sanitizeSubject(subject), '学习手册.docx')

      const upserted = upsertVideo(state, record)
      const { video, isNewSubject } = upserted
      addKeywords(state, subject, keywords)
      state.lastObservation = {
        source: observation.source ?? 'manual',
        title: finalTitle,
        url: record.url,
        at: Date.now(),
      }
      state.updatedAt = Date.now()
      save(paths.statePath, state)

      let docxError = null
      let manualDocx = null
      try {
        const meta = buildVideoMeta(video, content)
        writePair({
          mdPath: record.noteMd,
          docxPath: record.noteDocx,
          metaPath: record.noteMeta,
          markdown: renderVideoNote(summary, meta),
          meta,
        })
        manualDocx = writeManual(subject)
        writeOverview()
      } catch (error) {
        docxError = errorText(error)
        emit({ type: 'log', level: 'error', message: 'Word 生成失败：' + docxError })
      }
      markSeen(state, { ...observation, title: finalTitle, bvid: record.bvid }, 'course', { subject })
      state.updatedAt = Date.now()
      save(paths.statePath, state)
      stage('done', 100, '知识总结完成')
      const result = {
        ok: true,
        taskId,
        title: finalTitle,
        subject,
        keywords,
        coverage: content?.coverage ?? null,
        pic: record.pic ?? '',
        isNewSubject,
        noteDocx: existsSyncSafe(record.noteDocx) ? record.noteDocx : null,
        manualDocx,
        docxError,
        markdown: summary,
        durationMs: Date.now() - startedAt,
      }
      emit({ type: 'summary:done', ...result, at: Date.now() })
      return result
    } catch (error) {
      emit({
        type: 'task',
        taskId,
        stage: 'error',
        progress: 100,
        title: observation.title,
        message: '总结失败：' + errorText(error),
        at: Date.now(),
      })
      emit({ type: 'error', scope: 'pipeline', message: errorText(error), at: Date.now() })
      return { ok: false, taskId, error: errorText(error) }
    } finally {
      running = false
      currentBridge = null
      bridge.setOnDelta(null)
    }
  }

  return {
    runTask,
    abort() {
      aborted = true
      try {
        currentBridge?.abort?.()
      } catch {
        /* ignore */
      }
    },
    get running() {
      return running
    },
  }
}

function existsSyncSafe(path) {
  try {
    return Boolean(path) && existsSync(path)
  } catch {
    return false
  }
}
