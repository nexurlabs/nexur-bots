/**
 * Event routines: a small HTTP listener in the app that turns POSTs into routine runs.
 *
 * Each event routine has a secret URL `http://<host>:<port>/hooks/<token>`. A POST there is checked
 * (size cap, GitHub event filter, optional HMAC `X-Hub-Signature-256`) and handed to the renderer,
 * which runs the routine's Hermes cron job with the request body as context. HMAC secrets are kept
 * sealed (Electron safeStorage) in `<userData>/hooks.json` and never leave the main process.
 *
 * Listens on 127.0.0.1 by default; "accept from other machines" binds all interfaces.
 */
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')

const MAX_BODY = 1024 * 1024
const DEFAULT_PORT = 8648

/**
 * Constant-time check of an `X-Hub-Signature-256` header. Compares bytes, not string lengths: a
 * header with multi-byte characters can match `want` in string length but not in byte length, and
 * timingSafeEqual throws a RangeError on that. Any failure is a mismatch, never a throw.
 */
function signatureOk(given, want) {
  try {
    const a = Buffer.from(String(given || ''), 'utf8')
    const b = Buffer.from(String(want || ''), 'utf8')
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function init({ app, ipcMain, BrowserWindow, seal, unseal }) {
  const file = () => path.join(app.getPath('userData'), 'hooks.json')
  let state = { port: DEFAULT_PORT, lan: false, hooks: {} }
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }
  } catch {}
  const save = () => {
    try {
      fs.writeFileSync(file(), JSON.stringify(state, null, 2), { mode: 0o600 })
    } catch {}
  }

  let server = null
  let status = { running: false, error: '' }

  const addresses = () =>
    Object.values(os.networkInterfaces())
      .flat()
      .filter(a => a && a.family === 'IPv4' && !a.internal)
      .map(a => a.address)

  const reply = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const safeReply = (res, code, body) => {
    try {
      if (!res.headersSent && !res.writableEnded) reply(res, code, body)
      else if (!res.writableEnded) res.end()
    } catch {}
  }

  // GitHub presets: "push", "pull_request.opened", "pull_request.merged", "issues.opened", "*".
  const githubKey = (event, body) => {
    let json = null
    try {
      json = JSON.parse(body)
    } catch {}
    const action = json && typeof json.action === 'string' ? json.action : ''
    if (event === 'pull_request' && action === 'closed' && json?.pull_request?.merged) return ['pull_request.merged', 'pull_request.closed', 'pull_request']
    return [action ? `${event}.${action}` : event, event]
  }

  const handle = (req, res) => {
    const match = /^\/hooks\/([A-Za-z0-9_-]{16,64})\/?$/.exec((req.url || '').split('?')[0])
    if (req.method !== 'POST' || !match) return reply(res, 404, { error: 'not found' })
    const hook = state.hooks[match[1]]
    if (!hook) return reply(res, 404, { error: 'not found' })

    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        tooBig = true
        req.destroy()
      } else chunks.push(chunk)
    })
    // A request that errors (client reset, destroyed for size) must not become an uncaught 'error'.
    req.on('error', () => {
      if (!tooBig) safeReply(res, 400, { error: 'bad request' })
    })
    req.on('end', () => {
      try {
        onEnd()
      } catch (err) {
        // Nothing in the handler may throw out of an event callback: that would crash the main process.
        console.error('[hooks] request failed:', err)
        safeReply(res, 500, { error: 'internal error' })
      }
    })
    const onEnd = () => {
      if (tooBig) return reply(res, 413, { error: 'body too large' })
      const raw = Buffer.concat(chunks)
      const body = raw.toString('utf8')
      const event = String(req.headers['x-github-event'] || req.headers['x-event-type'] || 'webhook')

      const secret = hook.secret ? unseal(hook.secret) : ''
      // A configured secret that cannot be decrypted is not an unsigned hook.
      // Stop the event and tell the operator to restore the secret instead of
      // silently accepting a request without its signature.
      if (hook.secret && !secret) return reply(res, 503, { error: 'webhook secret unavailable; set it again' })
      if (secret) {
        const given = String(req.headers['x-hub-signature-256'] || '')
        const want = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex')
        if (!signatureOk(given, want)) return reply(res, 401, { error: 'bad signature' })
      }

      if (hook.kind === 'github') {
        if (event === 'ping') return reply(res, 200, { status: 'pong' })
        const keys = githubKey(event, body)
        const wanted = hook.events && hook.events.length ? hook.events : ['*']
        if (!wanted.includes('*') && !keys.some(k => wanted.includes(k))) return reply(res, 200, { status: 'ignored', event: keys[0] })
        hook.lastEvent = keys[0]
      } else {
        hook.lastEvent = event
      }

      hook.lastFired = Date.now()
      save()
      const payload = { token: match[1], bot: hook.bot, routineId: hook.routineId, event: hook.lastEvent, body: body.slice(0, 200_000), at: hook.lastFired }
      const wins = BrowserWindow.getAllWindows()
      if (!wins.length) return reply(res, 503, { error: 'app window not open' })
      for (const win of wins) win.webContents.send('hooks:event', payload)
      reply(res, 202, { status: 'accepted', event: hook.lastEvent })
    }
  }

  const start = () =>
    new Promise(resolve => {
      if (server) server.close()
      server = http.createServer((req, res) => {
        try {
          handle(req, res)
        } catch (err) {
          console.error('[hooks] request failed:', err)
          safeReply(res, 500, { error: 'internal error' })
        }
      })
      server.on('error', err => {
        status = { running: false, error: String(err.message || err) }
        resolve()
      })
      server.listen(state.port, state.lan ? '0.0.0.0' : '127.0.0.1', () => {
        status = { running: true, error: '' }
        resolve()
      })
    })

  const ensure = async () => {
    if (Object.keys(state.hooks).length && !status.running) await start()
  }

  const view = () => ({
    port: state.port,
    lan: state.lan,
    addresses: addresses(),
    ...status,
    hooks: Object.entries(state.hooks).map(([token, h]) => ({
      token,
      bot: h.bot,
      routineId: h.routineId,
      kind: h.kind,
      events: h.events || [],
      hasSecret: !!h.secret,
      lastFired: h.lastFired || 0,
      lastEvent: h.lastEvent || ''
    }))
  })

  ipcMain.handle('hooks:list', async () => {
    await ensure()
    return view()
  })

  ipcMain.handle('hooks:put', async (_e, input) => {
    const token = input.token && state.hooks[input.token] ? input.token : crypto.randomBytes(18).toString('base64url')
    const prev = state.hooks[token] || {}
    state.hooks[token] = {
      ...prev,
      bot: String(input.bot),
      routineId: String(input.routineId),
      kind: input.kind === 'github' ? 'github' : 'webhook',
      events: Array.isArray(input.events) ? input.events.map(String).slice(0, 20) : [],
      // undefined keeps the old secret, '' clears it.
      secret: input.secret === undefined ? prev.secret || '' : input.secret ? seal(String(input.secret)) : ''
    }
    save()
    await ensure()
    return { token, ...view() }
  })

  // "Send test event": a real POST to the listener, signed like GitHub would if the routine has a secret.
  ipcMain.handle('hooks:test', async (_e, { token, event, body }) => {
    const hook = state.hooks[String(token)]
    if (!hook) throw new Error('No such event routine')
    await ensure()
    const raw = Buffer.from(String(body || '{}'))
    const headers = { 'Content-Type': 'application/json', 'Content-Length': raw.length, 'X-Event-Type': 'test' }
    if (hook.kind === 'github') headers['X-GitHub-Event'] = String(event || 'ping')
    const secret = hook.secret ? unseal(hook.secret) : ''
    if (hook.secret && !secret) return { code: 503, error: 'webhook secret unavailable; set it again' }
    if (secret) headers['X-Hub-Signature-256'] = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex')
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: state.port, method: 'POST', path: `/hooks/${token}`, headers }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          let json = {}
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {}
          resolve({ ...json, code: res.statusCode })
        })
      })
      req.on('error', reject)
      req.end(raw)
    })
  })

  ipcMain.handle('hooks:remove', async (_e, token) => {
    delete state.hooks[String(token)]
    save()
    return view()
  })

  ipcMain.handle('hooks:config', async (_e, { port, lan }) => {
    const p = Number(port)
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) state.port = p
    state.lan = !!lan
    save()
    await start()
    return view()
  })

  app.whenReady().then(() => void ensure())

  return {
    stop: () =>
      new Promise(resolve => {
        if (!server) return resolve()
        server.close(() => resolve())
        server = null
        status = { running: false, error: '' }
      })
  }
}

module.exports = { init, signatureOk }
