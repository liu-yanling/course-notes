/**
 * dsh-video-coursemap — Python/docx bridge.
 *
 * DSH ships Python 3.12 with python-docx; the system python (3.9) does not.
 * We therefore locate the bundled interpreter explicitly instead of trusting
 * PATH.
 * @module dsh-video-coursemap/docx
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'md2docx.py')

let cachedPython = null

function candidates() {
  const list = []
  if (process.env.COURSE_NOTES_PYTHON) list.push(process.env.COURSE_NOTES_PYTHON)
  if (process.env.COURSE_ASSISTANT_PYTHON) list.push(process.env.COURSE_ASSISTANT_PYTHON)
  const runtimes = join(homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const runtime of readdirSync(runtimes)) {
      const base = join(runtimes, runtime, 'dependencies', 'python')
      list.push(join(base, 'bin', 'python3'), join(base, 'python.exe'))
    }
  } catch {
    /* no runtimes */
  }
  // App bundle layout: Contents/Resources/runtime/node → ../python.
  const bundled = join(dirname(process.execPath), '..', 'python', 'bin', 'python3')
  if (existsSync(bundled)) list.push(bundled)
  const resources = join(dirname(process.execPath), '..', 'Resources')
  const primary = join(resources, 'runtime', 'primary-runtime', 'dependencies', 'python')
  list.push(join(primary, 'bin', 'python3'), join(primary, 'python.exe'))
  list.push(
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/python/bin/python3',
  )
  list.push('python3', 'python')
  return [...new Set(list)]
}

/** Find an interpreter that can import python-docx. */
export function findPython({ force = false } = {}) {
  if (!force && cachedPython) return cachedPython
  for (const candidate of candidates()) {
    if (candidate.includes('/') && !existsSync(candidate)) continue
    try {
      const result = spawnSync(candidate, ['-c', 'import docx'], { timeout: 10000 })
      if (result.status === 0) {
        cachedPython = candidate
        return candidate
      }
    } catch {
      /* next candidate */
    }
  }
  return null
}

export function md2docxScript() {
  return SCRIPT_PATH
}

/**
 * Convert one Markdown file to Word.
 * @param {{mdPath: string, docxPath: string, metaPath?: string|null, pythonPath?: string|null}} input
 */
export function convertToDocx({ mdPath, docxPath, metaPath = null, pythonPath = null }) {
  const python = pythonPath ?? findPython()
  if (!python) throw new Error('未找到带 python-docx 的 Python（DSH 自带运行时可用）')
  mkdirSync(dirname(docxPath), { recursive: true })
  const args = [SCRIPT_PATH, mdPath, docxPath, ...(metaPath ? [metaPath] : [])]
  const result = spawnSync(python, args, {
    timeout: 90000,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 800)
    throw new Error(`md2docx 转换失败（${python}）：${detail}`)
  }
  return docxPath
}

export function writeMeta(metaPath, meta) {
  mkdirSync(dirname(metaPath), { recursive: true })
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8')
}

/** Open a .docx with python-docx and return basic structural facts. */
export function validateDocx(docxPath, { pythonPath = null } = {}) {
  const python = pythonPath ?? findPython()
  if (!python) return { ok: false, error: 'no python-docx' }
  const code = [
    'import json, sys',
    'from docx import Document',
    'd = Document(sys.argv[1])',
    'text = "\\n".join(p.text for p in d.paragraphs)',
    'print(json.dumps({"paragraphs": len(d.paragraphs), "tables": len(d.tables), "chars": len(text), "head": text[:200]}))',
  ].join('\n')
  const result = spawnSync(python, ['-c', code, docxPath], {
    timeout: 30000,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr || result.stdout || '').slice(0, 500) }
  }
  try {
    const facts = JSON.parse(String(result.stdout ?? '').trim())
    return { ok: facts.paragraphs > 0, ...facts }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}
