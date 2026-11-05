/**
 * Standalone course-assistant configuration.
 *
 * This module has no DSH runtime dependency. It stores its own config under
 * server/config.json and derives the engine config consumed by the existing
 * dsh-video-coursemap pure modules.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLayout, pathsFor } from '../apps/dsh-video-coursemap/lib/state.js'

export const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = resolve(SERVER_DIR, '..')
export const PUBLIC_DIR = join(APP_ROOT, 'public')
export const PLUGIN_DIR = join(APP_ROOT, 'apps', 'dsh-video-coursemap')
// Product data home: kept outside the read-only app bundle so an internal beta
// can be dragged into /Applications and still write notes/config.
export const DATA_HOME = resolve(
  process.env.COURSE_NOTES_DATA_DIR || join(homedir(), 'Documents', 'course notes'),
)
export const DEFAULT_OUTPUT_DIR = join(DATA_HOME, '课程知识地图')
export const CONFIG_PATH = join(DATA_HOME, 'config.json')
export const RUNTIME_PATH = join(DATA_HOME, 'runtime.json')
export const LOG_DIR = join(DATA_HOME, 'logs')
export const LOG_PATH = join(LOG_DIR, 'server.log')

export const DEFAULTS = {
  enabled: true,
  pollIntervalMs: 15000,
  stablePolls: 2,
  backend: 'auto',
  fetchContent: true,
  outputDir: DEFAULT_OUTPUT_DIR,
  autoOpen: true,
  onboardingDone: false,
  notifyOnComplete: true,
  updateUrl: String(process.env.COURSE_NOTES_UPDATE_URL || '').trim(),
  llm: {
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    useDshKey: true,
    apiKey: '',
  },
  server: {
    host: '127.0.0.1',
    port: 43110,
  },
}

const BACKENDS = new Set(['auto', 'tabbit', 'chromium', 'applescript', 'manual'])
const PROVIDERS = new Set(['deepseek', 'ollama', 'local'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, extra) {
  if (!isPlainObject(extra)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = deepMerge(base[key], value)
    else if (value !== undefined) out[key] = value
  }
  return out
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function absolutePath(value, fallback) {
  const text = String(value ?? '').trim()
  if (!text) return fallback
  const expanded = text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text
  return isAbsolute(expanded) ? resolve(expanded) : resolve(APP_ROOT, expanded)
}

/** Normalize arbitrary input into a safe config. */
export function normalizeConfig(input = {}, base = DEFAULTS) {
  const merged = deepMerge(deepMerge(DEFAULTS, base), isPlainObject(input) ? input : {})
  const provider = PROVIDERS.has(merged.llm?.provider) ? merged.llm.provider : 'deepseek'
  const defaultModel =
    provider === 'ollama' ? 'deepseek-r1:7b' : provider === 'local' ? 'local' : 'deepseek-chat'
  let model = String(merged.llm?.model ?? defaultModel).trim() || defaultModel
  if (provider === 'local') model = 'local'
  else if (provider === 'ollama' && (model === 'deepseek-chat' || model === 'local')) model = 'deepseek-r1:7b'
  else if (provider === 'deepseek' && (model === 'local' || model === 'deepseek-r1:7b')) model = 'deepseek-chat'
  const config = {
    enabled: merged.enabled !== false,
    pollIntervalMs: clamp(merged.pollIntervalMs, 3000, 600000, 15000),
    stablePolls: clamp(merged.stablePolls, 1, 5, 2),
    backend: BACKENDS.has(merged.backend) ? merged.backend : 'auto',
    fetchContent: merged.fetchContent !== false,
    outputDir: absolutePath(merged.outputDir, DEFAULT_OUTPUT_DIR),
    autoOpen: merged.autoOpen !== false,
    onboardingDone: merged.onboardingDone === true,
    notifyOnComplete: merged.notifyOnComplete !== false,
    updateUrl: String(merged.updateUrl || '').trim(),
    llm: {
      provider,
      model,
      baseUrl: String(merged.llm?.baseUrl ?? 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '') || 'https://api.deepseek.com/v1',
      useDshKey: merged.llm?.useDshKey !== false,
      apiKey: String(merged.llm?.apiKey ?? '').trim(),
    },
    server: {
      host: '127.0.0.1',
      port: clamp(merged.server?.port, 1024, 65535, 43110),
    },
  }
  return config
}

export function loadConfig() {
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    raw = {}
  }
  return normalizeConfig(raw)
}

export function saveConfig(config) {
  mkdirSync(DATA_HOME, { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })
  const normalized = normalizeConfig(config)
  const tmp = CONFIG_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, CONFIG_PATH)
  try {
    chmodSync(CONFIG_PATH, normalized.llm.apiKey ? 0o600 : 0o644)
  } catch {
    /* ignore */
  }
  ensureLayout(configPaths(normalized))
  return normalized
}

/** Merge a partial patch into the current config. */
export function patchConfig(current, patch = {}) {
  const safePatch = {}
  for (const key of ['enabled', 'pollIntervalMs', 'stablePolls', 'backend', 'fetchContent', 'outputDir', 'autoOpen', 'onboardingDone', 'notifyOnComplete', 'updateUrl']) {
    if (patch[key] !== undefined) safePatch[key] = patch[key]
  }
  if (patch.llm !== undefined) safePatch.llm = patch.llm
  if (patch.server !== undefined) safePatch.server = patch.server
  return normalizeConfig(safePatch, current)
}

/** Public shape for the browser: no secret. */
export function publicConfig(config) {
  return {
    enabled: config.enabled,
    pollIntervalMs: config.pollIntervalMs,
    stablePolls: config.stablePolls,
    backend: config.backend,
    fetchContent: config.fetchContent,
    outputDir: config.outputDir,
    autoOpen: config.autoOpen,
    onboardingDone: config.onboardingDone,
    notifyOnComplete: config.notifyOnComplete,
    updateUrl: config.updateUrl,
    llm: {
      provider: config.llm.provider,
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
      useDshKey: config.llm.useDshKey,
      apiKeySet: Boolean(config.llm.apiKey),
    },
    server: { host: config.server.host, port: config.server.port },
  }
}

/** Paths used by the engine and server. */
export function configPaths(config) {
  return pathsFor({ outputDir: config.outputDir })
}

/** Derived config for the pure engine modules. */
export function engineConfig(config) {
  const provider = config.llm.provider
  return {
    enabled: config.enabled,
    pollIntervalMs: config.pollIntervalMs,
    stablePolls: config.stablePolls,
    outputDir: config.outputDir,
    provider,
    model: config.llm.model,
    maxTokens: 4096,
    titleMinLen: 4,
    fetchContent: config.fetchContent,
    rebuildOnStartup: false,
    logMaxBytes: 2 * 1024 * 1024,
    browser: {
      backend: config.backend,
      tabbitTask: 'course-assistant-detect',
      chromeRecencyMinutes: 30,
      appleScriptEnabled: true,
    },
    delivery: { newSession: false, cwd: null, present: false, memory: false },
    summary: { maxDanmaku: 120, maxComments: 20, maxDescChars: 1200 },
  }
}

export function ensureServerDirs() {
  for (const dir of [DATA_HOME, LOG_DIR, join(APP_ROOT, 'public'), join(APP_ROOT, 'desktop')]) {
    mkdirSync(dir, { recursive: true })
  }
}

export const configFilePath = CONFIG_PATH
export const runtimeFilePath = RUNTIME_PATH
export const logFilePath = LOG_PATH
