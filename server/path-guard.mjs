/**
 * Output-directory path guard for the standalone server.
 */
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export function isInside(root, target) {
  const rootAbs = resolve(root)
  const targetAbs = resolve(target)
  const rel = relative(rootAbs, targetAbs)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

export function assertInside(root, target, label = 'path') {
  if (!isInside(root, target)) {
    const error = new Error(`${label} 不在输出目录内：${target}`)
    error.code = 'OUTSIDE_OUTPUT_DIR'
    throw error
  }
  return resolve(target)
}

/** Resolve a relative path against root; absolute paths must be inside. */
export function resolveOutputPath(root, input) {
  const value = String(input ?? '').trim()
  if (!value) {
    const error = new Error('缺少路径')
    error.code = 'INVALID_PATH'
    throw error
  }
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value)
  assertInside(root, target)
  return target
}

/** Reject symlinks that escape the output root. */
export function assertRealInside(root, target, label = 'path') {
  const resolved = assertInside(root, target, label)
  try {
    const realRoot = realpathSync(resolve(root))
    const realTarget = realpathSync(resolved)
    assertInside(realRoot, realTarget, label)
  } catch (error) {
    if (error.code === 'ENOENT') return resolved
    throw error
  }
  return resolved
}

export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
