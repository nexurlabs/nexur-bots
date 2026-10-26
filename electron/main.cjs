// NexurBots — Electron main process.
// Owns everything the renderer can't do from a web page: finding (or
// starting) a local Hermes backend, SSH tunnels to remote machines, REST
// calls (CORS), the saved-connections file and native dialogs.
const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, nativeTheme, globalShortcut, clipboard, session, systemPreferences } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const localComputer = require('./local-computer.cjs')
const localServe = require('./local-serve.cjs')
const guards = require('./guards.cjs')
const { explainLocalStartError } = require('./local-start.cjs')
const { checkKeyFile, explainKeyError } = require('./ssh-key.cjs')
const { registrationsFor } = require('./tool-routes.cjs')
const { adoptOldDataFolder, OLD_NAME } = require('./app-data.cjs')
const tokenStore = require('./token-store.cjs')
const { ensureGateway } = require('./gateway-ensure.cjs')
const { tokenCopyDirFor } = require('./token-dir.cjs')

// Before anything reads settings: the data folder used to be named after Hermes Bots (see app-data.cjs).
if (process.env.HERMES_BOTS_SMOKE !== '1') {
  const oldData = path.join(app.getPath('appData'), OLD_NAME)
  if (adoptOldDataFolder(app.getPath('userData'), oldData) === 'kept-old') app.setPath('userData', oldData)
}

const children = new Set()
let win = null

// ── settings file ─────────────────────────────────────────────────────────
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeSettings(value) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(value, null, 2))
}

function seal(text) {
  if (!text) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64')
  } catch {}
  return 'raw:' + Buffer.from(text, 'utf8').toString('base64')
}

function unseal(text) {
  if (!text) return ''
  try {
    if (text.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(text.slice(4), 'base64'))
    if (text.startsWith('raw:')) return Buffer.from(text.slice(4), 'base64').toString('utf8')
  } catch {}
  return ''
}

require('./hooks.cjs').init({ app, ipcMain, BrowserWindow, seal, unseal })

ipcMain.handle('settings:get', () => {
  const settings = readSettings()
  const connections = (settings.connections || []).map(c => ({ ...c, token: unseal(c.token) }))
  return { ...settings, connections }
})

ipcMain.handle('settings:set', (_e, patch) => {
  const current = readSettings()
  const next = { ...current, ...patch }
  if (Array.isArray(patch.connections)) {
    next.connections = patch.connections.map(c => ({ ...c, token: seal(c.token || '') }))
  }
  writeSettings(next)
  return true
})

// ── HTTP (from main: no CORS) ─────────────────────────────────────────────
// The renderer only reaches machines the user set up: loopback (this PC and SSH tunnels), saved
// connections, or an address the user confirmed in a dialog this session (connecting to a new
// remote machine before it is saved). A bot-controlled renderer can't use this as an open proxy.
const trustedOrigins = new Set()
const trustAsks = new Map()

function confirmOrigin(event, origin) {
  if (trustAsks.has(origin)) return trustAsks.get(origin)
  const win = BrowserWindow.fromWebContents(event.sender)
  const ask = dialog
    .showMessageBox(win, {
      type: 'question',
      buttons: ['Allow', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Connect to ${origin}?`,
      detail: 'This address is not one of your saved machines. Only allow it if you are adding a Hermes machine at this address.'
    })
    .then(({ response }) => {
      if (response === 0) trustedOrigins.add(origin)
      return response === 0
    })
    .catch(() => false)
    .finally(() => trustAsks.delete(origin))
  trustAsks.set(origin, ask)
  return ask
}

ipcMain.handle('http', async (event, { baseUrl, token, method = 'GET', path: route, body, timeoutMs = 20000 } = {}) => {
  const target = guards.targetFor(baseUrl, route)
  if (target.error) return { ok: false, status: 0, json: null, text: `Blocked: ${target.error}` }
  const connections = readSettings().connections || []
  if (!guards.isKnownTarget(target.url, connections, trustedOrigins) && !(await confirmOrigin(event, target.url.origin))) {
    return { ok: false, status: 0, json: null, text: `Blocked: ${target.url.origin} is not a configured machine` }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { Accept: 'application/json' }
    if (token) headers['X-Hermes-Session-Token'] = token
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(target.url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    return { ok: res.ok, status: res.status, json, text: json ? undefined : text.slice(0, 400) }
  } catch (error) {
    return { ok: false, status: 0, json: null, text: String(error && error.message ? error.message : error) }
  } finally {
    clearTimeout(timer)
  }
})

// ── local backend discovery ───────────────────────────────────────────────
function lockDir() {
  if (process.env.HERMES_GATEWAY_LOCK_DIR) return path.resolve(process.env.HERMES_GATEWAY_LOCK_DIR)
  const stateHome =
    process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)
      ? process.env.XDG_STATE_HOME
      : path.join(os.homedir(), '.local', 'state')
  return path.join(stateHome, 'hermes', 'gateway-locks')
}

function hermesHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
  return path.join(os.homedir(), '.hermes')
}

const fingerprint = token => crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16)

async function alive(baseUrl) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    const res = await fetch(baseUrl + '/api/health', { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

ipcMain.handle('local:discover', async () => {
  const dir = lockDir()
  const found = []
  for (const role of ['desktop-serve', 'serve']) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, `host-${role}.json`), 'utf8'))
      const token = fs.readFileSync(path.join(dir, `host-${role}.token`), 'utf8').trim()
      if (!record.port || !token || fingerprint(token) !== record.tokenFingerprint) continue
      const host = record.host && record.host !== '0.0.0.0' ? record.host : '127.0.0.1'
      const baseUrl = `http://${host}:${record.port}`
      if (await alive(baseUrl)) found.push({ baseUrl, token, role, pid: record.pid })
    } catch {}
  }
  if (ownedLocal && (await alive(ownedLocal.baseUrl))) found.push({ ...ownedLocal, role: 'bots-app' })
  return found
})

let ownedLocal = null

function hermesCommand() {
  const candidates =
    process.platform === 'win32'
      ? [path.join(hermesHome(), 'bin', 'hermes.exe'), path.join(hermesHome(), 'hermes-agent', 'venv', 'Scripts', 'hermes.exe')]
      : [path.join(os.homedir(), '.local', 'bin', 'hermes'), path.join(hermesHome(), 'bin', 'hermes')]
  return candidates.find(p => fs.existsSync(p)) || 'hermes'
}

// The `hermes serve` this app started that has not printed its ready line yet (see local-serve.cjs).
let pendingLocal = null

function launchLocalServe() {
  const token = crypto.randomBytes(24).toString('hex')
  const command = hermesCommand()
  let child
  try {
    child = spawn(command, ['serve', '--host', '127.0.0.1', '--port', '0'], {
      env: { ...process.env, HERMES_DASHBOARD_SESSION_TOKEN: token, PYTHONUNBUFFERED: '1' },
      windowsHide: true
    })
  } catch (error) {
    dbg(`local:start: could not run ${command}: ${error && error.message}`)
    throw explainLocalStartError(error)
  }
  children.add(child)
  const pending = { child, token, serve: localServe.watchServe(child) }
  child.on('exit', () => {
    children.delete(child)
    if (pendingLocal === pending) pendingLocal = null
  })
  return pending
}

ipcMain.handle('local:start', async () => {
  if (ownedLocal && (await alive(ownedLocal.baseUrl))) return ownedLocal
  // A serve still coming up (the last wait timed out, say) is waited for, not replaced: a second one
  // would contend with the first for Hermes' files while it updates.
  if (!pendingLocal) pendingLocal = launchLocalServe()
  const pending = pendingLocal
  let port

  try {
    port = await localServe.waitForServe(pending.serve, { home: hermesHome(), onStep: step })
  } catch (error) {
    // Cancelled while starting: the renderer has already moved on, so this result is never shown.
    if (pending.cancelled) throw new Error('Cancelled')
    if (error.timedOut) {
      // Still starting: keep the process, so the next Connect waits for this same one.
      // The output is logged with this launch's session token blanked out, in case Hermes echoed it.
      const output = String(error.output || '').split(pending.token).join('[token]')
      dbg('hermes serve not ready yet:', error.message, '| output:', JSON.stringify(output))
      throw error
    }
    pendingLocal = null
    // The raw error (e.g. "spawn hermes ENOENT") goes to the log; the app gets a plain explanation.
    dbg(`local:start: hermes serve failed: ${error && error.message}`)
    throw explainLocalStartError(error)
  }

  // A cancel that landed just as the serve became ready must not register its tools on Hermes.
  if (pending.cancelled) {
    localServe.cancelServe(pending)
    throw new Error('Cancelled')
  }
  pendingLocal = null
  ownedLocal = { baseUrl: `http://127.0.0.1:${port}`, token: pending.token }
  syncThisPcMcp({ baseUrl: ownedLocal.baseUrl, hermesToken: pending.token, cfg: null }).catch(() => {})
  return ownedLocal
})

// Routines only fire while a Hermes gateway runs; start one that doesn't idle-exit (see gateway-ensure.cjs).
ipcMain.handle('hermes:ensureGateway', async () => {
  const result = await ensureGateway({ command: hermesCommand(), home: hermesHome() })
  dbg(`gateway ensure: ${result.state}${result.reason ? ` (${result.reason})` : ''}`)
  return result
})

// ── machines already set up in Hermes Desktop ─────────────────────────────
// Hermes keeps its saved machines in <AppData>/<Hermes>/connections.json.
// SSH entries are plain host/user/key fields (no secrets), so we can reuse them.
ipcMain.handle('hermes:machines', () => {
  const roots = [app.getPath('appData')]
  const found = []
  const seen = new Set()
  for (const root of roots) {
    let dirs = []
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    } catch {}
    for (const dir of dirs) {
      if (!/hermes/i.test(dir) || /bots/i.test(dir)) continue
      const file = path.join(root, dir, 'connections.json')
      let data
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      for (const c of Array.isArray(data.connections) ? data.connections : []) {
        if (c && c.kind === 'ssh' && c.host) {
          const key = `${c.user || ''}@${c.host}:${c.port || 22}`
          if (seen.has(key)) continue
          seen.add(key)
          found.push({ id: `hermes-${c.id || key}`, kind: 'ssh', label: c.label || c.host, ssh: { host: c.host, user: c.user, port: c.port, keyPath: c.keyPath, remoteHermesPath: c.remoteHermesPath } })
        }
      }
    }
  }
  return found
})

// ── debug log ─────────────────────────────────────────────────────────────
// Written to <hermes home>/logs/hermes-bots.log (and next to the app settings)
// so a stuck connection can always be diagnosed after the fact.
function logTargets() {
  return [path.join(hermesHome(), 'logs', 'hermes-bots.log'), path.join(app.getPath('userData'), 'connect.log')]
}

function dbg(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`
  for (const file of logTargets()) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        if (fs.statSync(file).size > 400000) fs.writeFileSync(file, '')
      } catch {}
      fs.appendFileSync(file, line)
    } catch {}
  }
}

function step(text) {
  dbg('step:', text)
  try {
    if (win && !win.isDestroyed()) win.webContents.send('connect:step', text)
  } catch {}
}

// ── SSH ───────────────────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Same preference order Hermes Desktop uses: the in-box Windows OpenSSH, then
// Git for Windows' bundled ssh.exe, then whatever is on PATH.
function sshBinary() {
  if (process.platform !== 'win32') return 'ssh'
  const root = process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    path.join(root, 'System32', 'OpenSSH', 'ssh.exe'),
    'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\ssh.exe'
  ]
  return candidates.find(p => fs.existsSync(p)) || 'ssh'
}

function expandLocal(p) {
  const raw = String(p || '').trim().replace(/^"(.*)"$/, '$1')
  if (!raw) return ''
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(1))
  return raw.replace(/%([^%]+)%/g, (m, name) => process.env[name] || m)
}

const shq = value => `'${String(value).replace(/'/g, `'\\''`)}'`

function expandRemote(p) {
  const value = String(p || '').trim()
  if (value === '~') return '"$HOME"'
  if (value.startsWith('~/')) return '"$HOME"' + shq(value.slice(1))
  return shq(value)
}

function sshOptions(connectSecs) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${connectSecs}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'TCPKeepAlive=yes'
  ]
}

function hostArgs(cfg) {
  const args = []
  if (cfg.port && Number(cfg.port) !== 22) args.push('-p', String(cfg.port))
  const key = expandLocal(cfg.keyPath)
  if (key) args.push('-i', key)
  return args
}

const targetOf = cfg => (cfg.user ? `${cfg.user}@${cfg.host}` : cfg.host)

function explainSsh(raw, cfg) {
  const text = String(raw || '').trim()
  const key = expandLocal(cfg.keyPath)
  const who = targetOf(cfg)
  if (/ENOENT/.test(text) || /not recognized|cannot find/i.test(text) && /ssh/i.test(text))
    return 'The OpenSSH client was not found on this PC. Turn on "OpenSSH Client" in Windows Optional Features, then try again.'
  const keyMsg = explainKeyError(text, key)
  if (keyMsg) return keyMsg
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text))
    return `The VM's identity changed (new server or reinstall). Remove its old line from ${path.join(os.homedir(), '.ssh', 'known_hosts')} and try again.`
  if (/Permission denied|publickey|Too many authentication/i.test(text))
    return `The VM refused the login for ${who}. ${key ? `Key used: ${key}.` : 'No key file is set — add one under "Over SSH", or load your key into ssh-agent.'} If the key has a passphrase, load it into ssh-agent first.`
  if (/timed out|timeout/i.test(text) && !/Hermes/.test(text))
    return `Can't reach ${cfg.host}. The VM may be stopped, or its firewall / security group blocks SSH (port ${cfg.port || 22}) from this network.`
  if (/refused/i.test(text)) return `${cfg.host} is up but nothing is accepting SSH on port ${cfg.port || 22}.`
  if (/Could not resolve|Name or service not known|getaddrinfo/i.test(text)) return `Can't find a machine called ${cfg.host}.`
  if (/network is unreachable|no route to host/i.test(text)) return `No network route to ${cfg.host}. Check this PC's internet / VPN.`
  return text.split(/\r?\n/).filter(Boolean).slice(-6).join('\n').slice(0, 500) || 'SSH failed'
}

const pending = new Set()
let cancelled = false

function track(child) {
  pending.add(child)
  child.on('exit', () => pending.delete(child))
  return child
}

ipcMain.handle('ssh:cancel', () => {
  cancelled = true
  dbg('cancel requested')
  for (const child of [...pending]) {
    try {
      child.kill()
    } catch {}
  }
  // A Hermes this app is starting here stops too, so Cancel never leaves one running (see local-serve.cjs).
  if (pendingLocal) {
    localServe.cancelServe(pendingLocal)
    dbg('cancel requested: stopped the hermes serve that was starting')
    pendingLocal = null
  }
  return true
})

// Run one remote command; stdout lines are streamed to onLine. Resolves with
// { code, out, err }. Never rejects for a non-zero exit, only for spawn errors.
function runSsh(cfg, remoteCommand, { timeoutMs = 60000, connectSecs = 12, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const args = [...sshOptions(connectSecs), ...hostArgs(cfg), '--', targetOf(cfg), remoteCommand]
    dbg('ssh exec:', sshBinary(), args.map(a => (a.length > 90 ? a.slice(0, 90) + '…' : a)).join(' '))
    let child
    try {
      child = spawn(sshBinary(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    track(child)
    let out = ''
    let err = ''
    let carry = ''
    let done = false
    const finish = fn => value => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish(resolve)({ code: -1, out, err: err || 'Timed out', timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      const text = chunk.toString()
      out += text
      carry += text
      let index
      while ((index = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, index).replace(/\r$/, '')
        carry = carry.slice(index + 1)
        if (onLine) onLine(line)
      }
    })
    child.stderr.on('data', chunk => (err += chunk.toString()))
    child.on('error', finish(reject))
    child.on('exit', code => {
      dbg('ssh exec exit', String(code), '| stderr:', err.trim().slice(-300).replace(/\n/g, ' ⏎ '))
      finish(resolve)({ code, out, err })
    })
  })
}

// One shell line, run by the VM's login shell so PATH matches a real login.
function remoteScript({ hermesPath, token, fresh }) {
  const find = hermesPath
    ? `H=${expandRemote(hermesPath)}; [ -x "$H" ] || { echo "ERR=badpath"; exit 4; }`
    : 'H=$(command -v hermes 2>/dev/null); if [ ! -x "$H" ]; then H=; for c in "$HOME/.local/bin/hermes" /usr/local/bin/hermes "$HOME/.hermes/hermes-agent/venv/bin/hermes" "$HOME/.hermes/bin/hermes"; do if [ -x "$c" ]; then H="$c"; break; fi; done; fi; [ -n "$H" ] || { echo "ERR=nohermes"; exit 4; }'
  const reuse = fresh
    ? 'rm -f "$D/serve.port"'
    : 'if [ -s "$D/serve.pid" ] && [ -s "$D/serve.port" ]; then OP=$(cat "$D/serve.pid"); if kill -0 "$OP" 2>/dev/null && tr "\\0" " " < "/proc/$OP/cmdline" 2>/dev/null | grep -q " serve"; then echo "STEP=Hermes is already running on the VM"; echo "PORT=$(cat "$D/serve.port")"; exit 0; fi; fi'
  const spawnIt =
    'rm -f "$D/serve.log"; ulimit -n 65536 2>/dev/null || true; ' +
    `nohup env HERMES_DESKTOP=1 HERMES_DASHBOARD_SESSION_TOKEN=${token} "$H" serve --isolated --host 127.0.0.1 --port 0 </dev/null >"$D/serve.log" 2>&1 & ` +
    'echo $! > "$D/serve.pid"; echo "STEP=Starting Hermes on the VM…"'
  const wait =
    'i=0; while [ $i -lt 240 ]; do ' +
    'P=$(grep -Eo "HERMES_(BACKEND|DASHBOARD)_READY port=[0-9]+" "$D/serve.log" 2>/dev/null | head -1 | sed "s/.*port=//"); ' +
    'if [ -n "$P" ]; then echo "$P" > "$D/serve.port"; echo "PORT=$P"; exit 0; fi; ' +
    'kill -0 "$(cat "$D/serve.pid")" 2>/dev/null || { echo "ERR=died"; tail -n 25 "$D/serve.log" 2>/dev/null; exit 5; }; ' +
    'i=$((i+1)); if [ $((i%6)) -eq 0 ]; then echo "STEP=Waiting for Hermes to wake up ($((i*3/4))s)…"; fi; sleep 0.75; done; ' +
    'echo "ERR=timeout"; tail -n 25 "$D/serve.log" 2>/dev/null; exit 3'
  const body = ['D="$HOME/.hermes-bots"', 'mkdir -p "$D"', find, 'echo "STEP=Found Hermes on the VM"', reuse, spawnIt, wait].join('; ')
  return `bash -lc ${shq(body)}`
}

async function readServedToken(baseUrl, fallback) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(baseUrl + '/', { signal: controller.signal })
    clearTimeout(timer)
    const html = await res.text()
    const match = /window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:\\.|[^"\\])*")/.exec(html)
    if (match) return JSON.parse(match[1])
  } catch (error) {
    dbg('could not read served token:', String(error && error.message))
  }
  return fallback
}

const sshTunnels = new Map()
const sshInflight = new Map()

// Keep the forward alive: laptops sleep, Wi-Fi drops. Re-open on the same port.
function openTunnel(cfg, entry) {
  const args = [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `${entry.localPort}:127.0.0.1:${entry.remotePort}`,
    ...sshOptions(15),
    ...hostArgs(cfg),
    '--',
    targetOf(cfg)
  ]
  dbg('ssh tunnel:', sshBinary(), args.join(' '))
  const child = spawn(sshBinary(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  const startedAt = Date.now()
  children.add(child)
  entry.child = child
  entry.err = ''
  child.stderr.on('data', chunk => (entry.err += chunk.toString()))
  child.on('error', error => {
    entry.err += String(error && error.message)
  })
  child.on('exit', code => {
    children.delete(child)
    dbg('ssh tunnel exited', String(code), '|', entry.err.trim().slice(-200).replace(/\n/g, ' ⏎ '))
    if (entry.closed || entry.child !== child) return
    // A tunnel that died straight away means the VM or the network is unreachable: back off
    // (2.5s → 30s) instead of hammering it; one that ran a while is retried quickly.
    entry.wait = Date.now() - startedAt < 20000 ? Math.min(30000, (entry.wait || 1250) * 2) : 2500
    if (entry.ready) setTimeout(() => !entry.closed && openTunnel(cfg, entry), entry.wait)
  })
  return child
}

// ── This PC (computer use) ─────────────────────────────────────────────────
// A separate, best-effort reverse tunnel: if its port is taken on the VM it just
// doesn't forward (no ExitOnForwardFailure here), and it can never affect the main
// dashboard tunnel above since it's a wholly separate ssh process.
const reverseTunnels = new Map()

function remoteMcpPortFor(cfg) {
  const key = `${cfg.user || ''}@${cfg.host}:${cfg.port || 22}`
  const hash = crypto.createHash('sha256').update(key).digest()
  return 40000 + (hash.readUInt16BE(0) % 1000)
}

function openReverseTunnel(cfg, localPort) {
  const key = `${cfg.user || ''}@${cfg.host}:${cfg.port || 22}`
  const remotePort = remoteMcpPortFor(cfg)
  const existing = reverseTunnels.get(key)
  if (existing && existing.localPort === localPort && existing.child && existing.child.exitCode === null) return remotePort
  if (existing) {
    existing.closed = true
    try {
      existing.child && existing.child.kill()
    } catch {}
  }
  const entry = { localPort, remotePort, child: null, closed: false, err: '' }
  const spawnIt = () => {
    if (entry.closed) return
    const args = ['-N', '-R', `${remotePort}:127.0.0.1:${localPort}`, ...sshOptions(15), ...hostArgs(cfg), '--', targetOf(cfg)]
    dbg('reverse tunnel (this-pc mcp):', sshBinary(), args.join(' '))
    const child = spawn(sshBinary(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const startedAt = Date.now()
    children.add(child)
    entry.child = child
    entry.err = ''
    child.stderr.on('data', chunk => (entry.err += chunk.toString()))
    child.on('exit', code => {
      children.delete(child)
      dbg('reverse tunnel (this-pc mcp) exited', String(code), '|', entry.err.trim().slice(-200).replace(/\n/g, ' ⏎ '))
      if (entry.closed || reverseTunnels.get(key) !== entry) return
      entry.wait = Date.now() - startedAt < 20000 ? Math.min(30000, (entry.wait || 2000) * 2) : 4000
      setTimeout(() => spawnIt(), entry.wait)
    })
  }
  spawnIt()
  reverseTunnels.set(key, entry)
  return remotePort
}

// Registers (re-registers, really — delete then create) the local computer-use MCP
// server with the Hermes gateway. Best-effort: any failure here is logged, never thrown,
// so it can't break an otherwise-successful connect. `cfg` is the ssh config for a remote
// VM, or null when the gateway is this same PC (no tunnel needed).
//
// Every bot is its own Hermes profile with its own config, so the server has to be
// registered once per profile (the REST API takes a `profile` query param) — otherwise only
// the default profile's bot could ever see this PC. `thisPcLink` remembers the live
// connection so the renderer can ask for more profiles later (new bots, reconnects).
// Several Hermes machines: one link per Hermes base URL. `thisPcLink` is the first one (the
// app's main machine); the others are keyed by base URL. A bot on another machine has a
// renderer-side name `<profile>@<host id>`; `hostSuffix` maps each base URL to its `@<id>`.
let thisPcLink = null
const thisPcLinks = new Map()
const thisPcProfilesBy = new Map()
const hostSuffix = new Map()
const linkProfiles = link => {
  if (!thisPcProfilesBy.has(link.baseUrl)) thisPcProfilesBy.set(link.baseUrl, new Set())
  return thisPcProfilesBy.get(link.baseUrl)
}
// `name@h2` -> { link, profile: 'name' }; plain names use the main link.
function linkFor(who) {
  const at = String(who || '').lastIndexOf('@')
  if (at > 0) {
    const suffix = who.slice(at)
    for (const [base, sfx] of hostSuffix) if (sfx === suffix && thisPcLinks.get(base)) return { link: thisPcLinks.get(base), profile: who.slice(0, at) }
    return { link: null, profile: who.slice(0, at) }
  }
  return { link: thisPcLink, profile: who }
}

/**
 * What the profile's own MCP entry is, read back from Hermes after it was written.
 *
 * `GET /api/mcp/servers?profile=<name>` is scoped to that profile's config, so this is the pair
 * *this* profile will actually use — not the pair the app meant to write. The bearer is never in
 * the answer: Hermes keeps it in the profile's `.env` and only the header template persists. What
 * proves ownership is the route plus the fact that a bearer is required at all, since the groups
 * route answers every tool call as whoever presents `Bearer groupToken(<profile>)`.
 */
async function confirmMcpEntry(link, profile, name, url, bearer) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (link.hermesToken) headers['X-Hermes-Session-Token'] = link.hermesToken
  const base = link.baseUrl.replace(/\/?$/, '/')
  const scope = profile && profile !== 'default' ? `?profile=${encodeURIComponent(profile)}` : ''

  const res = await fetch(new URL(`api/mcp/servers${scope}`, base).toString(), { headers })
  if (!res.ok) {
    return { ok: false, why: `Hermes answered ${res.status} for this profile's servers` }
  }

  const body = await res.json().catch(() => null)
  const servers = body && Array.isArray(body.servers) ? body.servers : null
  if (!servers) {
    return { ok: false, why: 'Hermes did not report this profile\'s servers' }
  }

  const entry = servers.find(server => server && server.name === name)
  if (!entry) {
    return { ok: false, why: `'${name}' is not registered for this profile` }
  }

  if (entry.enabled === false) {
    return { ok: false, why: `'${name}' is disabled for this profile` }
  }

  // Compare the routes, not the strings: the write strips nothing and nothing else should add
  // anything, so anything that is not the same URL is another profile's route.
  const stored = String(entry.url || '').replace(/\/+$/, '')
  const wanted = String(url).replace(/\/+$/, '')

  if (stored !== wanted) {
    // Deliberately logs only the entry that is wrong, never the tokens involved.
    dbg(name, 'mcp entry belongs to another route', profile || 'default', ':', stored || '(unset)')
    return { ok: false, why: 'the registered url is not this profile\'s own' }
  }

  if (!bearer || !String(bearer).trim()) {
    return { ok: false, why: 'no bearer to write, so the route would answer as whoever already has one' }
  }

  // A header entry is the only shape that carries the bearer; without it the route is unauthenticated.
  const headersOn = entry.headers
  const needsAuth = entry.auth === 'header' || entry.auth === 'oauth' || (headersOn && typeof headersOn === 'object' && Object.keys(headersOn).length > 0)

  if (!needsAuth) {
    return { ok: false, why: 'the registered entry carries no authorization header' }
  }

  return { ok: true }
}

async function unregisterMcp(link, profile, name) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (link.hermesToken) headers['X-Hermes-Session-Token'] = link.hermesToken
  const base = link.baseUrl.replace(/\/?$/, '/')
  const scope = profile && profile !== 'default' ? `?profile=${encodeURIComponent(profile)}` : ''
  try {
    await fetch(new URL(`api/mcp/servers/${encodeURIComponent(name)}${scope}`, base).toString(), { method: 'DELETE', headers })
  } catch {}
}

// Where the VM runner answers group conversations, when it does (set in settings.json). Empty = the
// app answers them itself, as before.
function runnerGroupsUrl() {
  const url = readSettings().runnerGroupsUrl

  return typeof url === 'string' ? url.trim() : ''
}

/**
 * Writes one bot's group tool entries. Returns whether its conversation entry is confirmed, which is
 * what gates the bot's first turn. With a runner, the conversation tools point at it and the app's
 * own tools stay on this PC under their own server name.
 */
async function registerGroupTools(link, profile, who) {
  const plan = registrationsFor({ mcpUrl: link.mcpUrl, runnerGroupsUrl: runnerGroupsUrl(), who })

  for (const name of plan.remove) {
    await unregisterMcp(link, profile, name)
  }

  let groupsOk = false

  for (const entry of plan.add) {
    const bearer = entry.token === 'app' ? localComputer.appToken(who) : localComputer.groupToken(who)
    const ok = await registerMcp(link, profile, entry.name, entry.url, bearer)

    if (entry.name === 'hermes-bots-groups') groupsOk = ok
  }

  return groupsOk
}

async function registerMcp(link, profile, name, url, bearer) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (link.hermesToken) headers['X-Hermes-Session-Token'] = link.hermesToken
  const base = link.baseUrl.replace(/\/?$/, '/')
  const scope = profile && profile !== 'default' ? `?profile=${encodeURIComponent(profile)}` : ''
  try {
    await fetch(new URL(`api/mcp/servers/${encodeURIComponent(name)}${scope}`, base).toString(), { method: 'DELETE', headers })
  } catch {}
  const res = await fetch(new URL(`api/mcp/servers${scope}`, base).toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, url, auth: 'header', bearer_token: bearer })
  })
  dbg(name, 'mcp register', profile || 'default', ':', String(res.status), (await res.text().catch(() => '')).slice(0, 160))
  if (!res.ok) return false

  // Writing the right pair is not the same as it being the pair this profile will use. A profile
  // cloned from default can arrive already carrying default's groups URL and bearer together, and a
  // POST that is accepted but not applied — or that fails after the DELETE — leaves that inherited
  // pair in place. A connection test alone cannot tell the two apart: an inherited default URL and
  // a valid default bearer connect perfectly well, as default. So the entry is read back from the
  // profile's own config and has to name this profile's route before the profile is called ready.
  let entry

  try {
    entry = await confirmMcpEntry(link, profile, name, url, bearer)
  } catch (error) {
    // Hermes could not be asked, so the entry is unproven. That is not the same as it being wrong,
    // but reporting it as ready would claim something nobody checked.
    dbg(name, 'mcp register could not confirm', profile || 'default', ':', String(error && error.message))
    return false
  }

  if (!entry.ok) {
    dbg(name, 'mcp register unconfirmed', profile || 'default', ':', entry.why)
    return false
  }

  // Now that the entry is this profile's, a probe says the route is reachable *as this profile*.
  // Its tools are the app's own (`post_to_group`, `ask_user`, …), so the list is also the proof that
  // the entry is one Hermes will actually call, rather than a dead route that merely looks right.
  try {
    const check = await fetch(new URL(`api/mcp/servers/${encodeURIComponent(name)}/test${scope}`, base).toString(), {
      method: 'POST',
      headers
    })
    const raw = await check.text()
    let body = null

    try {
      body = JSON.parse(raw)
    } catch {
      body = null
    }

    // An unreadable or unproven probe is unproven. Falling back to `{}` and only testing
    // `ok === false` is what let an HTTP 500 and a non-JSON body read as success.
    if (!check.ok) {
      dbg(name, 'mcp probe failed', profile || 'default', ':', String(check.status))
      return false
    }

    if (!body || typeof body !== 'object' || body.ok !== true) {
      dbg(name, 'mcp probe did not confirm', profile || 'default', ':', String(check.status))
      return false
    }

    dbg(name, 'mcp register verified', profile || 'default', ':', String(check.status))
  } catch (error) {
    dbg(name, 'mcp probe could not run', profile || 'default', ':', String(error && error.message))
    return false
  }

  return true
}

// Profiles whose This PC entry is marked `trust: untrusted`, so Hermes asks before each action.
const thisPcAsks = new Map()

// Hermes only stops a tool call for approval on an MCP server set to `trust: untrusted`, and
// `POST /api/mcp/servers` can't carry that field, so it's written into the profile's config right
// after (`PUT /api/config` deep-merges, touching nothing else). With it, Hermes sends the bot's
// session an approval request for every This PC tool not annotated read-only, and the app shows
// it as an approval card in that chat. Hermes re-reads it on the tool reload the app asks for.
async function markThisPcUntrusted(link, profile) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (link.hermesToken) headers['X-Hermes-Session-Token'] = link.hermesToken
  const base = link.baseUrl.replace(/\/?$/, '/')
  const scope = profile && profile !== 'default' ? `?profile=${encodeURIComponent(profile)}` : ''
  try {
    const res = await fetch(new URL(`api/config${scope}`, base).toString(), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ config: { mcp_servers: { [localComputer.SERVER_NAME]: { trust: 'untrusted' } } } })
    })
    dbg('this-pc mcp trust untrusted', profile || 'default', ':', String(res.status))
    return res.ok
  } catch (error) {
    dbg('this-pc mcp trust failed for', profile || 'default', ':', String(error && error.message))
    return false
  }
}

// Per-bot conversation readiness, keyed by the renderer's bot name (`default`, `x-manager`,
// `x-manager@h2`, …). This is the groups/profile barrier and it is deliberately NOT the same thing
// as This PC: a PC server that registered fine says the bot can drive the screen, and nothing about
// who its tool calls will be attributed to. Value: true = proven ready, false = known not ready,
// undefined = never proven (which is not ready either — see `groupsReady`).
const groupsReadyBy = new Map()

// What `groupsReadyBy` holds, resolved fail-closed: absent means nobody proved it, and nobody
// proved it is not the same as it being fine.
function groupsReady(who) {
  return groupsReadyBy.get(who || 'default') === true
}

async function registerThisPc(link, profile, whoAs) {
  const who = whoAs || profile || 'default'
  const ok = await registerMcp(link, profile, localComputer.SERVER_NAME, link.mcpUrl, link.mcpToken)
  thisPcAsks.set(who, ok && (await markThisPcUntrusted(link, profile)))

  // The app's group tools ride on the same server, one URL and token per bot so a call says who is
  // posting. Best-effort by design: a failure here never blocks This PC. But it is recorded, because
  // "best effort" means the PC result, not that a bot whose groups route is unproven can have its
  // first turn. That is what `groupsReady` and the first-submit barrier are for.
  try {
    const groupsOk = await registerGroupTools(link, profile, who)

    groupsReadyBy.set(who, groupsOk)
  } catch (error) {
    dbg('groups mcp register failed for', profile || 'default', ':', String(error && error.message))
    groupsReadyBy.set(who, false)
  }

  return ok
}

// Asks Hermes itself to connect to the PC server and list its tools — the same check
// `hermes mcp test` does. This is the one answer that says "a bot will be able to use it".
async function checkThisPc(who) {
  const asked = who
  const { link, profile } = linkFor(who)
  if (!link) return { ok: false, tools: [], error: 'Not connected to that Hermes yet.' }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (link.hermesToken) headers['X-Hermes-Session-Token'] = link.hermesToken
  const base = link.baseUrl.replace(/\/?$/, '/')
  const scope = profile && profile !== 'default' ? `?profile=${encodeURIComponent(profile)}` : ''
  try {
    const res = await fetch(new URL(`api/mcp/servers/hermes-bots-this-pc/test${scope}`, base).toString(), { method: 'POST', headers })
    const body = await res.json().catch(() => ({}))
    const tools = Array.isArray(body.tools) ? body.tools.map(tool => String(tool.name || tool)) : []
    const error = body.ok ? '' : String(body.error || body.detail || `Hermes answered ${res.status}`)
    dbg('this-pc mcp test', profile || 'default', ':', body.ok ? `ok, ${tools.length} tools` : `FAILED ${error.slice(0, 300)}`)
    return { ok: !!body.ok, tools, error, asks: thisPcAsks.get(asked || 'default') !== false }
  } catch (error) {
    const message = String((error && error.message) || error)
    dbg('this-pc mcp test', profile || 'default', ': FAILED', message)
    return { ok: false, tools: [], error: message, asks: thisPcAsks.get(asked || 'default') !== false }
  }
}

// Where the copy of the This PC token lives outside the data folder (token-store.cjs). None in the CI smoke test.
// Windows only: the copy is DPAPI-sealed (see token-dir.cjs).
const tokenCopyDir = () =>
  tokenCopyDirFor({ platform: process.platform, env: process.env, home: os.homedir(), name: app.getName(), smoke: process.env.HERMES_BOTS_SMOKE === '1' })

// The This PC token, decided once per run: the one in settings, else the copy outside the data folder,
// else none (startServer makes a new one). Same token every launch, so Hermes processes that are still
// holding the old registration keep working, even after the data folder was wiped.
let thisPcTokenReady = null
function thisPcSavedToken() {
  if (!thisPcTokenReady) {
    thisPcTokenReady = (async () => {
      const saved = unseal(readSettings().thisPcToken || '')
      if (saved || !tokenCopyDir()) return saved
      const kept = await tokenStore.loadToken(tokenCopyDir())
      if (kept) dbg('this-pc token: restored from the copy outside the data folder')
      return kept
    })()
  }
  return thisPcTokenReady
}

// Keeps the copy in step with the token in use, once per run. The fingerprint check spares a PowerShell
// start on every launch; it only runs when the copy is missing or holds another token.
let tokenCopyChecked = false
function keepTokenCopy(token) {
  if (tokenCopyChecked || !tokenCopyDir()) return
  tokenCopyChecked = true
  if (tokenStore.copyMatches(tokenCopyDir(), token)) return
  void tokenStore.saveToken(tokenCopyDir(), token).then(ok => dbg(`this-pc token copy outside the data folder: ${ok ? 'saved' : 'could not save'}`))
}

async function syncThisPcMcp({ baseUrl, hermesToken, cfg }) {
  try {
    const savedToken = await thisPcSavedToken()
    const { port: mcpPort, token: mcpToken } = await localComputer.startServer({ onLog: dbg, token: savedToken, port: readSettings().thisPcPort })
    if (mcpToken !== unseal(readSettings().thisPcToken || '')) writeSettings({ ...readSettings(), thisPcToken: seal(mcpToken) })
    if (readSettings().thisPcPort !== mcpPort) writeSettings({ ...readSettings(), thisPcPort: mcpPort })
    keepTokenCopy(mcpToken)
    const mcpUrl = cfg ? `http://127.0.0.1:${openReverseTunnel(cfg, mcpPort)}/mcp` : `http://127.0.0.1:${mcpPort}/mcp`
    const old = thisPcLinks.get(baseUrl)
    const sameServer = old && old.mcpToken === mcpToken && old.mcpUrl === mcpUrl
    const link = { baseUrl, hermesToken, mcpUrl, mcpToken }
    thisPcLinks.set(baseUrl, link)
    // A machine with no `@id` suffix is the app's main one.
    if (!hostSuffix.get(baseUrl)) thisPcLink = link
    if (!sameServer) linkProfiles(link).clear()
    const sfx = hostSuffix.get(baseUrl) || ''
    // Each machine's own default profile, under its renderer name.
    await registerThisPc(link, 'default', sfx ? `default${sfx}` : 'default')
    void checkThisPc(sfx ? `default${sfx}` : 'default')
    // The renderer may have asked for bot profiles before the link existed.
    const wanted = wantedBy.get(baseUrl) || (!sfx ? wantedBy.get('') : null)
    if (wanted && wanted.size) await syncThisPcProfiles([...wanted], { baseUrl, suffix: sfx })
  } catch (error) {
    dbg('this-pc mcp sync failed:', String(error && error.message))
  }
}

// Registers the PC server for the named bot profiles that don't have it yet. `opts` names the
// machine (its Hermes base URL and the `@id` suffix its bots carry in the app); none = the main one.
const wantedBy = new Map()
// A profile's registration in progress, per link (a rebuilt link starts its own). The renderer asks
// again every time the bot list loads, which happens several times while connecting; a second ask
// while the first is still running waits for it instead of registering the same profile again
// (startup used to make 4-5 rounds per bot, and the overlapping ones collided with HTTP 409).
const registering = new WeakMap()
async function syncThisPcProfiles(profiles, opts) {
  const baseUrl = (opts && typeof opts.baseUrl === 'string' && opts.baseUrl) || ''
  const suffix = (opts && typeof opts.suffix === 'string' && /^@[a-z0-9]{1,12}$/.test(opts.suffix) && opts.suffix) || ''
  if (baseUrl) hostSuffix.set(baseUrl, suffix)
  if (!wantedBy.has(baseUrl)) wantedBy.set(baseUrl, new Set())
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (typeof profile === 'string' && profile) wantedBy.get(baseUrl).add(profile)
  }
  const link = baseUrl ? thisPcLinks.get(baseUrl) : thisPcLink
  if (!link) return { ok: false, done: [] }
  const have = linkProfiles(link)
  const done = []
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (typeof profile !== 'string' || !profile || profile === 'default') continue
    // A cached profile is only skipped when its groups entry is still proven. The cache says "we
    // did this once", not "it is still true": Hermes can be reconfigured, a clone can be restored,
    // and a reconnect can land on a fresh gateway whose config says nothing about the old one. An
    // unproven entry is re-registered rather than assumed from the cache.
    if (have.has(profile) && groupsReady(profile + suffix)) continue
    if (!registering.has(link)) registering.set(link, new Map())
    const jobs = registering.get(link)
    let job = jobs.get(profile)
    if (!job) {
      job = registerThisPc(link, profile, profile + suffix).finally(() => jobs.delete(profile))
      jobs.set(profile, job)
    }
    try {
      if (await job) {
        have.add(profile)
        done.push(profile)
      }
    } catch (error) {
      dbg('this-pc mcp register failed for', profile, ':', String(error && error.message))
    }
  }
  return { ok: true, done, toolsRev: localComputer.TOOLS_REVISION }
}

/**
 * Confirms one bot's conversation identity, right before its first turn.
 *
 * This is the groups/profile barrier and it is independent of This PC: a bot can have a working PC
 * server and still not be proven to answer as itself. It re-registers the profile's own groups entry
 * and confirms it (fail-closed, see `confirmMcpEntry`), so a cached client, a restored clone or a
 * reconnecting gateway all have to prove the entry again rather than inherit an old answer. Returns
 * a reason on refusal so the user is told what went wrong instead of watching a message vanish.
 */
async function ensureGroupsIdentity(who) {
  const name = String(who || 'default')
  const { link, profile } = linkFor(name)

  if (!link) {
    return { ready: false, error: 'Not connected to that Hermes yet.' }
  }

  try {
    const ready = await registerGroupTools(link, profile, name)

    groupsReadyBy.set(name, ready)

    return ready
      ? { ready: true }
      : { ready: false, error: `${name} could not be confirmed as its own bot on this Hermes.` }
  } catch (error) {
    groupsReadyBy.set(name, false)

    return { ready: false, error: String((error && error.message) || error) }
  }
}

// Group chats live in the renderer, so the group tools ask it and wait for the answer.
const appToolWaits = new Map()
let appToolSeq = 0
localComputer.setAppToolHandler(
  (profile, name, args) =>
    new Promise(resolve => {
      if (!win || win.isDestroyed()) {
        resolve({ ok: false, text: 'The NexurBots app window is closed, so nothing was posted. Ask the user to open the app.' })
        return
      }
      const id = ++appToolSeq
      const timer = setTimeout(() => {
        appToolWaits.delete(id)
        resolve({ ok: false, text: "The NexurBots app didn't answer in time, so the post may not have gone through." })
      }, 30000)
      appToolWaits.set(id, answer => {
        clearTimeout(timer)
        resolve(answer)
      })
      win.webContents.send('apptool:call', { id, profile, name, args })
    })
)

ipcMain.on('apptool:result', (_event, answer) => {
  const id = answer && answer.id
  const wait = appToolWaits.get(id)
  if (!wait) return
  appToolWaits.delete(id)
  wait({ ok: !!answer.ok, text: String(answer.text || '').slice(0, 8000) })
})

function updatePanicShortcut(active) {
  try {
    globalShortcut.unregister('Control+Alt+Escape')
  } catch {}
  if (!active) return
  try {
    globalShortcut.register('Control+Alt+Escape', () => {
      localComputer.setGranted(false)
      dbg('panic stop: Ctrl+Alt+Esc pressed, control revoked')
    })
  } catch (error) {
    dbg('could not register panic hotkey:', String(error && error.message))
  }
}

localComputer.setOnGrantChange(value => {
  updatePanicShortcut(value)
  try {
    if (win && !win.isDestroyed()) win.webContents.send('computer:granted-changed', value)
  } catch {}
})

ipcMain.handle('computer:getState', () => localComputer.getState())
ipcMain.handle('computer:getLastShot', () => localComputer.getLastShot())
ipcMain.handle('computer:syncProfiles', (_e, profiles, opts) => syncThisPcProfiles(profiles, opts))
ipcMain.handle('log:write', (_e, text) => dbg('app:', String(text || '').slice(0, 500)))
ipcMain.handle('computer:check', (_e, profile) => checkThisPc(typeof profile === 'string' ? profile : 'default'))
// The conversation-identity barrier, called by the renderer just before a bot's first real turn.
ipcMain.handle('groups:ensureIdentity', (_e, who) => ensureGroupsIdentity(typeof who === 'string' ? who : 'default'))
ipcMain.handle('computer:setGranted', (_e, value) => {
  localComputer.setGranted(!!value)
  return localComputer.getState()
})

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll()
  } catch {}
  localComputer.stopServer()
})

async function waitHealthy(baseUrl, entry, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (cancelled) throw new Error('Cancelled')
    if (await alive(baseUrl)) return true
    if (entry.child && entry.child.exitCode !== null) return false
    await sleep(400)
  }
  return false
}

async function connectSsh(cfg) {
  cancelled = false
  const suffix = typeof cfg.hostSuffix === 'string' && /^@[a-z0-9]{1,12}$/.test(cfg.hostSuffix) ? cfg.hostSuffix : ''
  const key = `${cfg.user || ''}@${cfg.host}:${cfg.port || 22}`
  dbg('=== connect', key, 'key:', expandLocal(cfg.keyPath) || '(none)', 'hermes:', cfg.remoteHermesPath || '(auto)')
  const existing = sshTunnels.get(key)
  if (existing && (await alive(existing.baseUrl))) {
    step('Reconnecting…')
    const served = await readServedToken(existing.baseUrl, existing.token)
    hostSuffix.set(existing.baseUrl, suffix)
    syncThisPcMcp({ baseUrl: existing.baseUrl, hermesToken: served, cfg }).catch(() => {})
    return { baseUrl: existing.baseUrl, token: served }
  }
  if (existing) {
    existing.closed = true
    try {
      existing.child && existing.child.kill()
    } catch {}
    sshTunnels.delete(key)
  }

  const keyFile = expandLocal(cfg.keyPath)
  const keyProblem = checkKeyFile(keyFile)
  if (keyProblem) throw new Error(keyProblem)

  // 1) reach the VM and log in — fails fast with a readable reason.
  step(`Reaching ${cfg.host}…`)
  let probe
  try {
    probe = await runSsh(cfg, 'echo HB_OK', { timeoutMs: 30000, connectSecs: 12 })
  } catch (error) {
    throw new Error(explainSsh(error && error.message ? error.message : error, cfg))
  }
  if (cancelled) throw new Error('Cancelled')
  if (probe.code !== 0 || !/HB_OK/.test(probe.out)) {
    throw new Error(explainSsh(probe.timedOut ? 'timed out' : probe.err || probe.out, cfg))
  }
  step('Logged in to the VM')

  // 2) find / start Hermes there (reuse a running one when we can).
  const token = crypto.randomBytes(24).toString('hex')
  const entry = { baseUrl: '', token, localPort: await freePort(), remotePort: 0, child: null, ready: false, closed: false, err: '' }
  entry.baseUrl = `http://127.0.0.1:${entry.localPort}`

  for (const fresh of [false, true]) {
    let result
    try {
      result = await runSsh(cfg, remoteScript({ hermesPath: cfg.remoteHermesPath, token, fresh }), {
        timeoutMs: 200000,
        connectSecs: 15,
        onLine: line => {
          if (line.startsWith('STEP=')) step(line.slice(5))
        }
      })
    } catch (error) {
      throw new Error(explainSsh(error && error.message ? error.message : error, cfg))
    }
    if (cancelled) throw new Error('Cancelled')
    const out = result.out
    if (/ERR=nohermes/.test(out))
      throw new Error('Hermes is not installed on the VM (no `hermes` command found). Install it there, or set its path under "Over SSH".')
    if (/ERR=badpath/.test(out)) throw new Error(`The Hermes path "${cfg.remoteHermesPath}" is not an executable on the VM.`)
    const port = /PORT=(\d+)/.exec(out)
    if (!port) {
      const tail = out.split(/\r?\n/).filter(l => l && !l.startsWith('STEP=')).slice(-8).join('\n')
      if (/ERR=died/.test(out)) throw new Error('Hermes crashed while starting on the VM:\n' + tail)
      if (/ERR=timeout/.test(out) || result.timedOut) throw new Error('Hermes did not finish starting on the VM in time:\n' + tail)
      throw new Error(explainSsh(result.err || tail, cfg))
    }
    entry.remotePort = Number(port[1])

    // 3) forward a local port to it and make sure it answers.
    step('Opening the secure tunnel…')
    openTunnel(cfg, entry)
    const healthy = await waitHealthy(entry.baseUrl, entry, 25000)
    if (healthy) {
      entry.ready = true
      sshTunnels.set(key, entry)
      const served = await readServedToken(entry.baseUrl, token)
      hostSuffix.set(entry.baseUrl, suffix)
      syncThisPcMcp({ baseUrl: entry.baseUrl, hermesToken: served, cfg }).catch(() => {})
      step('Connected')
      return { baseUrl: entry.baseUrl, token: served }
    }
    entry.closed = true
    try {
      entry.child && entry.child.kill()
    } catch {}
    entry.closed = false
    if (cancelled) throw new Error('Cancelled')
    if (fresh) throw new Error(entry.err.trim() ? explainSsh(entry.err, cfg) : 'The tunnel opened but Hermes on the VM did not answer.')
    dbg('reused backend did not answer; starting a fresh one')
    step('Restarting Hermes on the VM…')
    entry.localPort = await freePort()
    entry.baseUrl = `http://127.0.0.1:${entry.localPort}`
  }
  throw new Error('Could not connect to the VM')
}

ipcMain.handle('ssh:connect', async (_e, cfg) => {
  const key = `${cfg.user || ''}@${cfg.host}:${cfg.port || 22}`
  if (sshInflight.has(key)) return sshInflight.get(key)
  const promise = connectSsh(cfg)
    .catch(error => {
      dbg('connect failed:', String(error && error.message))
      throw error
    })
    .finally(() => sshInflight.delete(key))
  sshInflight.set(key, promise)
  return promise
})

ipcMain.handle('log:path', () => logTargets()[0])

// ── misc ──────────────────────────────────────────────────────────────────
// ── files a bot sent (send_file): save with a dialog, or open with the OS default app ──
const safeFileName = name => String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 180) || 'file'
const bytesOf = dataUrl => Buffer.from(String(dataUrl || '').replace(/^data:[^,]*,/, ''), 'base64')

ipcMain.handle('file:save', async (event, { name, dataUrl }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(win, { title: `Save ${safeFileName(name)}`, defaultPath: path.join(app.getPath('downloads'), safeFileName(name)) })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  await fs.promises.writeFile(result.filePath, bytesOf(dataUrl))
  return { ok: true, path: result.filePath }
})

ipcMain.handle('file:open', async (_e, { name, dataUrl }) => {
  const dir = path.join(app.getPath('temp'), 'hermes-bots-files', crypto.randomBytes(4).toString('hex'))
  await fs.promises.mkdir(dir, { recursive: true })
  const target = path.join(dir, safeFileName(name))
  await fs.promises.writeFile(target, bytesOf(dataUrl))
  // A bot can send anything. Never hand an executable/script to the OS to run: show it in its
  // folder instead, and let the UI say why.
  if (guards.isDangerousFile(name) || guards.isDangerousFile(target)) {
    shell.showItemInFolder(target)
    return { ok: false, blocked: true, path: target, error: `${safeFileName(name)} can run code on this computer, so it was not opened. It is shown in its folder instead; open it yourself only if you trust it.` }
  }
  const error = await shell.openPath(target)
  return error ? { ok: false, error } : { ok: true, path: target }
})

ipcMain.handle('open:external', (_e, url) => {
  if (/^(https?:\/\/|mailto:)/i.test(String(url))) shell.openExternal(String(url))
})

ipcMain.handle('clipboard:copyText', (_e, text) => {
  clipboard.writeText(String(text || ''))
  return true
})

// The large Computer view pastes the local clipboard into the bot's desktop on Ctrl+V.
ipcMain.handle('clipboard:readText', () => clipboard.readText())

ipcMain.handle('pick:image', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  const file = result.filePaths[0]
  const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg')
  return `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}`
})

ipcMain.handle('window:toggleMax', () => {
  if (!win) return
  win.isMaximized() ? win.unmaximize() : win.maximize()
})

// ── window ────────────────────────────────────────────────────────────────
function createWindow() {
  nativeTheme.themeSource = 'dark'
  const settings = readSettings()
  const bounds = settings.bounds || { width: 1280, height: 820 }
  win = new BrowserWindow({
    ...bounds,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#070707',
    title: 'NexurBots',
    titleBarStyle: 'hidden',
    // Linux draws the overlay buttons itself and can't composite a transparent overlay: it showed a
    // blank grey box with no visible controls. Give it the app's opaque background so the
    // minimize/maximize/close glyphs render (Windows/macOS keep the transparent overlay).
    titleBarOverlay: { color: process.platform === 'linux' ? '#070707' : '#00000000', symbolColor: '#d6d6d6', height: 48 },
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (settings.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // A link in a reply must never replace the app: web links go to the browser, anything else is dropped.
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (/^(https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url)
  })
  const saveBounds = () => {
    if (!win || win.isDestroyed()) return
    const current = readSettings()
    writeSettings({ ...current, maximized: win.isMaximized(), bounds: win.isMaximized() ? current.bounds : win.getBounds() })
  }
  win.on('close', saveBounds)
}

// ── Desktop shortcut (Windows) ────────────────────────────────────────────
// Creates "NexurBots.lnk" on the Desktop the first time the app runs. It is
// tagged with the same AppUserModelID as the window, so launching from it and
// pinning it to the taskbar both group under one "NexurBots" button.
function ensureDesktopShortcut() {
  if (process.platform !== 'win32') return
  try {
    const settings = readSettings()
    if (settings.desktopShortcut === process.execPath) return
    // The shortcut used to be "Hermes Bots.lnk". Remove it only if it is ours: it opens this app, or an
    // old app file that is gone (the upgrade uninstalled the previous version).
    const oldLnk = path.join(app.getPath('desktop'), 'Hermes Bots.lnk')
    if (fs.existsSync(oldLnk)) {
      let target = ''
      try {
        target = shell.readShortcutLink(oldLnk).target || ''
      } catch {}
      if (target && (target === process.execPath || (/Hermes Bots\.exe$/i.test(target) && !fs.existsSync(target)))) fs.unlinkSync(oldLnk)
    }
    const lnk = path.join(app.getPath('desktop'), 'NexurBots.lnk')
    const options = {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      icon: process.execPath,
      iconIndex: 0,
      appUserModelId: 'com.hermes.bots',
      description: 'NexurBots'
    }
    const made = shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', options)
    if (made) writeSettings({ ...readSettings(), desktopShortcut: process.execPath })
  } catch (err) {
    try { dbg('desktop shortcut failed: ' + (err && err.message)) } catch {}
  }
}

app.setAppUserModelId('com.hermes.bots')
// Voice notes: the app's own page may use the microphone (audio only). Other permissions keep
// Electron's default (granted), as before this handler existed.
const ownPage = url => /^(file:|app:|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(String(url || ''))
function voicePermissions() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission !== 'media') return callback(true)
    const types = (details && details.mediaTypes) || []
    const audioOnly = types.length > 0 && types.every(type => type === 'audio')
    if (!audioOnly || !ownPage(details && (details.requestingUrl || details.securityOrigin))) return callback(false)
    if (process.platform === 'darwin' && systemPreferences.askForMediaAccess) {
      systemPreferences.askForMediaAccess('microphone').then(ok => callback(!!ok), () => callback(false))
      return
    }
    callback(true)
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (permission !== 'media') return true
    return ownPage(origin) && (!details || !details.mediaType || details.mediaType === 'audio')
  })
}

// CI smoke test (HERMES_BOTS_SMOKE=1, see tests/build/smoke.cjs): boot the built app, confirm the
// main process, preload and renderer all loaded, then exit. A missing require() fails it.
const SMOKE = process.env.HERMES_BOTS_SMOKE === '1'
if (SMOKE) {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bots-smoke-')))
  process.on('uncaughtException', err => {
    console.error('HERMES_BOTS_SMOKE_FAIL uncaught', err)
    app.exit(1)
  })
}
function smokeCheck() {
  const fail = why => {
    console.error('HERMES_BOTS_SMOKE_FAIL', why)
    app.exit(1)
  }
  win.webContents.on('preload-error', (_e, file, err) => fail(`preload ${file}: ${err && err.message}`))
  win.webContents.on('did-fail-load', (_e, code, desc) => fail(`load ${code} ${desc}`))
  win.webContents.on('render-process-gone', (_e, details) => fail(`renderer gone ${details && details.reason}`))
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const bridge = await win.webContents.executeJavaScript('typeof window.native')
        if (bridge !== 'object') return fail(`preload bridge missing (${bridge})`)
        console.log('HERMES_BOTS_SMOKE_OK')
        app.exit(0)
      } catch (err) {
        fail(String(err && err.message))
      }
    }, 2000)
  })
}

app.whenReady().then(() => {
  voicePermissions()
  createWindow()
  if (SMOKE) smokeCheck()
  else ensureDesktopShortcut()
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  for (const child of children) {
    try {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      else child.kill()
    } catch {}
  }
})
