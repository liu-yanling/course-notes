/**
 * dsh-video-coursemap — configuration resolution and validation.
 *
 * Resolution order (later wins):
 *   1. DEFAULTS
 *   2. <pluginDir>/config.json written by scripts/install.mjs
 *   3. the Cordis row config
 *
 * The installed plugin lives inside the DSH profile; config.json carries the
 * absolute workspace path so the Cordis patch itself stays machine-neutral.
 * @module dsh-video-coursemap/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULTS = {
  enabled: true,
  pollIntervalMs: 15000,
  stablePolls: 2,
  outputDir: null,
  provider: null,
  model: null,
  maxTokens: 4096,
  titleMinLen: 4,
  fetchContent: true,
  rebuildOnStartup: true,
  logMaxBytes: 2 * 1024 * 1024,
  browser: {
    backend: 'auto',
    tabbitTask: 'dsh-course-map',
    chromeRecencyMinutes: 30,
    appleScriptEnabled: true,
  },
  delivery: {
    newSession: true,
    cwd: null,
    present: true,
    memory: true,
    sessionTitlePrefix: '📚',
  },
  summary: {
    maxDanmaku: 120,
    maxComments: 20,
    maxDescChars: 1200,
  },
}

const BACKENDS = new Set(['auto', 'tabbit', 'chromium', 'applescript', 'manual'])

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

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function expandHome(value) {
  const text = String(value ?? '').trim()
  if (!text) return text
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

function absolutePath(value, base) {
  const expanded = expandHome(value)
  return isAbsolute(expanded) ? expanded : resolve(base, expanded)
}

/** Load config.json if present; never throws on malformed JSON. */
export function loadFileConfig(pluginDir = PLUGIN_DIR) {
  const file = join(pluginDir, 'config.json')
  if (!existsSync(file)) return {}
  const parsed = readJson(file)
  return isPlainObject(parsed) ? parsed : {}
}

function assertPositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`dsh-video-coursemap: ${name} 必须是正数`)
  }
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new Error(`dsh-video-coursemap: ${name} 必须是布尔值`)
  }
}

function assertOptionalString(value, name) {
  if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`dsh-video-coursemap: ${name} 必须是 null 或非空字符串`)
  }
}

/**
 * Resolve the final config.
 * @param {object} rawConfig - Cordis row config.
 * @param {{pluginDir?: string, home?: string}} options
 */
export function resolveConfig(rawConfig = {}, options = {}) {
  const pluginDir = options.pluginDir ?? PLUGIN_DIR
  const home = options.home ?? homedir()
  if (!isPlainObject(rawConfig)) {
    throw new Error('dsh-video-coursemap: 配置必须是对象')
  }

  const fileConfig = loadFileConfig(pluginDir)
  let config = deepMerge(deepMerge(DEFAULTS, fileConfig), rawConfig)

  // Unknown top-level keys are almost always typos; fail loud at mount time.
  const known = new Set(Object.keys(DEFAULTS))
  for (const key of Object.keys(config)) {
    if (!known.has(key)) throw new Error(`dsh-video-coursemap: 未知配置项 "${key}"`)
  }
  for (const group of ['browser', 'delivery', 'summary']) {
    const allowed = new Set(Object.keys(DEFAULTS[group]))
    for (const key of Object.keys(config[group] ?? {})) {
      if (!allowed.has(key)) throw new Error(`dsh-video-coursemap: 未知配置项 "${group}.${key}"`)
    }
    config[group] = { ...DEFAULTS[group], ...(config[group] ?? {}) }
  }

  assertBoolean(config.enabled, 'enabled')
  assertBoolean(config.fetchContent, 'fetchContent')
  assertBoolean(config.rebuildOnStartup, 'rebuildOnStartup')
  assertPositiveNumber(config.pollIntervalMs, 'pollIntervalMs')
  assertPositiveNumber(config.stablePolls, 'stablePolls')
  assertPositiveNumber(config.maxTokens, 'maxTokens')
  assertPositiveNumber(config.titleMinLen, 'titleMinLen')
  assertPositiveNumber(config.logMaxBytes, 'logMaxBytes')
  assertPositiveNumber(config.browser.chromeRecencyMinutes, 'browser.chromeRecencyMinutes')
  assertPositiveNumber(config.summary.maxDanmaku, 'summary.maxDanmaku')
  assertPositiveNumber(config.summary.maxComments, 'summary.maxComments')
  assertPositiveNumber(config.summary.maxDescChars, 'summary.maxDescChars')
  assertOptionalString(config.provider, 'provider')
  assertOptionalString(config.model, 'model')

  if (!BACKENDS.has(config.browser.backend)) {
    throw new Error(
      `dsh-video-coursemap: browser.backend 必须是 ${[...BACKENDS].join('|')}`,
    )
  }
  if (typeof config.browser.tabbitTask !== 'string' || config.browser.tabbitTask.trim() === '') {
    throw new Error('dsh-video-coursemap: browser.tabbitTask 必须是非空字符串')
  }
  assertBoolean(config.browser.appleScriptEnabled, 'browser.appleScriptEnabled')
  assertBoolean(config.delivery.newSession, 'delivery.newSession')
  assertBoolean(config.delivery.present, 'delivery.present')
  assertBoolean(config.delivery.memory, 'delivery.memory')
  if (typeof config.delivery.sessionTitlePrefix !== 'string') {
    throw new Error('dsh-video-coursemap: delivery.sessionTitlePrefix 必须是字符串')
  }

  config.outputDir = absolutePath(config.outputDir ?? join(home, '课程知识地图'), home)
  config.delivery.cwd = config.delivery.cwd ? absolutePath(config.delivery.cwd, home) : null
  config.pluginDir = pluginDir
  return config
}

/** Flatten a config into stable key=value pairs for status output. */
export function summarizeConfig(config) {
  return {
    enabled: config.enabled,
    pollIntervalMs: config.pollIntervalMs,
    stablePolls: config.stablePolls,
    outputDir: config.outputDir,
    backend: config.browser.backend,
    newSession: config.delivery.newSession,
    deliveryCwd: config.delivery.cwd,
    provider: config.provider,
    model: config.model,
  }
}
