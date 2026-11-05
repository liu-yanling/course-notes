/**
 * Persistent retry state for failed summarization tasks.
 *
 * A failed task is retried with a short backoff, survives an app restart, and
 * can be triggered manually from the UI. This is intentionally separate from
 * the polling timer so a failure does not silently disappear.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const MAX_RETRY_ATTEMPTS = 3
export const RETRY_DELAYS_MS = [30_000, 120_000, 300_000]

export function retryDelay(attempts) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Number(attempts) - 1))
  return RETRY_DELAYS_MS[index]
}

export function readRetry(file) {
  try {
    if (!existsSync(file)) return null
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || !data.observation || !data.observation.title) return null
    const attempts = Math.max(0, Number(data.attempts) || 0)
    if (attempts > MAX_RETRY_ATTEMPTS) return null
    return {
      observation: data.observation,
      attempts,
      nextAt: Number(data.nextAt) || 0,
      error: String(data.error ?? ''),
      at: Number(data.at) || Date.now(),
    }
  } catch {
    return null
  }
}

export function writeRetry(file, retry) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(retry, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

export function clearRetry(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    /* ignore */
  }
}
