/**
 * macOS completion notification. Uses osascript so the app needs no native
 * helper or extra permissions beyond Notification Center.
 */
import { spawn } from 'node:child_process'

function escapeAppleScript(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function notifyComplete(event) {
  if (process.platform !== 'darwin') return
  const title = 'course notes'
  const subject = String(event?.subject ?? '').trim()
  const video = String(event?.title ?? '').trim()
  const body = [subject, video].filter(Boolean).join(' · ').slice(0, 180) || '知识总结完成'
  const script = 'display notification "' + escapeAppleScript(body) + '" with title "' + title + '"'
  try {
    const child = spawn('/usr/bin/osascript', ['-e', script], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    /* notifications are optional */
  }
}
