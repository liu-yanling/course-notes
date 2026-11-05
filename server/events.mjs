/**
 * SSE event hub with a small snapshot and ring buffers.
 */
export function createEventHub({ maxPolls = 80, maxLogs = 120 } = {}) {
  const clients = new Set()
  const polls = []
  const logs = []
  let status = null
  let config = null

  function remember(event) {
    const at = event.at ?? Date.now()
    const stored = { ...event, at }
    if (event.type === 'poll') {
      polls.unshift(stored)
      if (polls.length > maxPolls) polls.length = maxPolls
    } else if (event.type === 'log') {
      logs.unshift(stored)
      if (logs.length > maxLogs) logs.length = maxLogs
    }
    if (event.type === 'status') status = stored
    if (event.type === 'config') config = event.config
    return stored
  }

  function write(res, event) {
    try {
      res.write('data: ' + JSON.stringify(event) + '\n\n')
    } catch {
      clients.delete(res)
    }
  }

  function broadcast(event) {
    const stored = remember(event)
    for (const res of clients) write(res, stored)
    return stored
  }

  function snapshot() {
    return {
      type: 'hello',
      at: Date.now(),
      status,
      config,
      polls: polls.slice(0, 50),
      logs: logs.slice(0, 30),
    }
  }

  function subscribe(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': 'http://' + (req.headers.host ?? '127.0.0.1'),
    })
    res.write('retry: 2000\n\n')
    write(res, snapshot())
    clients.add(res)
    req.on('close', () => {
      clients.delete(res)
    })
    res.on('error', () => {
      clients.delete(res)
    })
    return () => {
      clients.delete(res)
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping ' + Date.now() + '\n\n')
      } catch {
        clients.delete(res)
      }
    }
  }, 15000)
  heartbeat.unref?.()

  function closeAll() {
    clearInterval(heartbeat)
    for (const res of clients) {
      try {
        res.write('data: ' + JSON.stringify({ type: 'shutdown', at: Date.now() }) + '\n\n')
        res.end()
      } catch {
        /* ignore */
      }
    }
    clients.clear()
  }

  return {
    broadcast,
    subscribe,
    snapshot,
    closeAll,
    setStatus(value) {
      status = { type: 'status', at: Date.now(), ...(value ?? {}) }
      return status
    },
    getStatus() {
      return status
    },
    getPolls() {
      return polls.slice()
    },
    getLogs() {
      return logs.slice()
    },
    get clientCount() {
      return clients.size
    },
  }
}
