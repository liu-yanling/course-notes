/**
 * macOS Keychain storage for the user's DeepSeek API key.
 *
 * The key never goes into config.json, the browser, or logs. The login
 * keychain is unlocked by the user session; if the command fails, callers
 * surface a normal "key unavailable" error.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SECURITY = '/usr/bin/security'
const SERVICE = 'course-notes-deepseek'
const ACCOUNT = 'deepseek'

export function keychainAvailable() {
  return process.platform === 'darwin' && existsSync(SECURITY)
}

export function getKeychainKey() {
  if (!keychainAvailable()) return ''
  const result = spawnSync(
    SECURITY,
    ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'],
    { encoding: 'utf8', timeout: 5000 },
  )
  if (result.status !== 0) return ''
  return String(result.stdout ?? '').trim()
}

export function setKeychainKey(key) {
  const value = String(key ?? '').trim()
  if (!value) return { ok: false, error: 'Key 不能为空' }
  if (!keychainAvailable()) return { ok: false, error: '当前系统不支持 Keychain' }
  const result = spawnSync(
    SECURITY,
    ['add-generic-password', '-U', '-a', ACCOUNT, '-s', SERVICE, '-w', value],
    { encoding: 'utf8', timeout: 5000 },
  )
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr ?? 'Keychain 写入失败').trim().slice(0, 200) }
  }
  return { ok: true }
}

export function deleteKeychainKey() {
  if (!keychainAvailable()) return { ok: false, error: '当前系统不支持 Keychain' }
  const result = spawnSync(
    SECURITY,
    ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE],
    { encoding: 'utf8', timeout: 5000 },
  )
  // A missing item is not an error for the UI's "clear" action.
  if (result.status !== 0) return { ok: true, deleted: false }
  return { ok: true, deleted: true }
}

export function keychainStatus() {
  return {
    available: keychainAvailable(),
    keySet: Boolean(getKeychainKey()),
    service: SERVICE,
  }
}
