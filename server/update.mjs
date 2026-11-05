/**
 * Lightweight update manifest checker. The manifest is a static JSON file:
 *   { "version": "1.0.1", "downloadUrl": "https://…/Course Notes.dmg", "notes": "…" }
 */
export function compareVersions(left, right) {
  const parse = (value) => String(value ?? '').trim().replace(/^v/i, '').split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const av = a[index] || 0
    const bv = b[index] || 0
    if (av > bv) return 1
    if (av < bv) return -1
  }
  return 0
}

export async function checkForUpdate({
  currentVersion,
  updateUrl,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = String(updateUrl ?? '').trim()
  if (!url) {
    return { ok: false, configured: false, currentVersion, message: '尚未配置更新地址' }
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, configured: true, currentVersion, message: '更新地址必须是 http(s) URL' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache' },
    })
    if (!response.ok) {
      return { ok: false, configured: true, currentVersion, message: '更新服务返回 ' + response.status }
    }
    const data = await response.json()
    const latestVersion = String(data.version ?? '').trim()
    if (!latestVersion) {
      return { ok: false, configured: true, currentVersion, message: '更新清单缺少 version' }
    }
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0
    return {
      ok: true,
      configured: true,
      currentVersion,
      latestVersion,
      updateAvailable,
      downloadUrl: String(data.downloadUrl ?? '').trim(),
      sha256: String(data.sha256 ?? '').trim(),
      notes: String(data.notes ?? '').trim(),
      publishedAt: data.publishedAt ?? null,
    }
  } catch (error) {
    const message = error?.name === 'AbortError' ? '检查更新超时' : String(error?.message ?? error)
    return { ok: false, configured: true, currentVersion, message }
  } finally {
    clearTimeout(timer)
  }
}
