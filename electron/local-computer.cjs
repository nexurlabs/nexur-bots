// local-computer.cjs — lets a bot see and drive THIS PC (screenshots + mouse/keyboard),
// the same way Grok/Claude-style "computer use" works, but pointed at the user's own
// Windows machine instead of a sandboxed VM.
//
// Nothing here can run until the user flips "Allow control" on in the app (`granted`
// defaults to false, mirrors Hermes' own bot-desktop lease: fail closed). Every tool call,
// including a screenshot, is refused while `granted` is false.
//
// Shape of the whole feature:
//   1. This file runs a tiny hand-rolled MCP server (Streamable HTTP, JSON-RPC 2.0) on a
//      local loopback port. No MCP SDK is used — we can't add new npm dependencies to an
//      already-packaged Electron app, so the wire protocol is implemented directly against
//      the spec Hermes' own MCP client (the official Python `mcp` package) expects.
//   2. main.cjs reverse-forwards that port to the Hermes gateway's VM over the same SSH
//      tunnel it already opens (`-R <remotePort>:127.0.0.1:<localPort>`), then registers it
//      with the gateway via `POST /api/mcp/servers` (a documented, user-facing Hermes API —
///     nothing on the VM's own code is touched).
//   3. Screenshots come straight from Electron's built-in `desktopCapturer` (no native
//      modules). Mouse/keyboard input is simulated by a long-lived PowerShell helper process
//      that calls `user32.dll`'s `SendInput` — again no native modules, since those would need
//      a win32 binary compiled outside this build environment and there is no channel to ship
//      one into the already-installed app.

const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { isRunnerTool } = require('./tool-routes.cjs')

let electron = null
try {
  electron = require('electron')
} catch {}

const MAX_SHOT_WIDTH = 1280
const TOOL_PREFIX = 'computer_'

// ── state ───────────────────────────────────────────────────────────────────
let granted = false
let server = null
let port = 0
let token = ''
let onGrantChange = () => {}
let logFn = () => {}
let lastError = ''
let lastShot = null // { dataUrl, at } — most recent screenshot the bot took, for the UI preview
// Seam for tests: the real capture needs Electron's desktopCapturer. Production always
// uses captureScreenshot; only a test overrides it, so the image content block a bot
// receives can be asserted without a display.
let captureShot = captureScreenshot
// Answers the app's own tools (groups) in the renderer, which owns the group chats.
let appToolHandler = null

function log(...parts) {
  try {
    logFn(...parts)
  } catch {}
}

// ── PowerShell input helper (mouse + keyboard; screenshots use Electron directly) ──
let ps = null
let psBuf = ''
let psWaiters = []
let psReady = null

const PS_LINES = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'namespace HBInput {',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct POINT { public int X; public int Y; }',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '  [StructLayout(LayoutKind.Explicit)]',
  '  public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct INPUT { public uint type; public INPUTUNION u; }',
  '  public class Native {',
  '    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);',
  '    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
  '    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);',
  '  }',
  '}',
  '"@',
  '$INPUT_SIZE = [System.Runtime.InteropServices.Marshal]::SizeOf([type][HBInput.INPUT])',
  'function Send-Mouse([uint32]$flags, [int]$data) {',
  '  $mi = New-Object HBInput.MOUSEINPUT; $mi.dwFlags = $flags; $mi.mouseData = $data',
  '  $u = New-Object HBInput.INPUTUNION; $u.mi = $mi',
  '  $inp = New-Object HBInput.INPUT; $inp.type = 0; $inp.u = $u',
  '  [HBInput.Native]::SendInput(1, [HBInput.INPUT[]]@($inp), $INPUT_SIZE) | Out-Null',
  '}',
  'function Send-Key([uint16]$vk, [uint16]$scan, [uint32]$flags) {',
  '  $ki = New-Object HBInput.KEYBDINPUT; $ki.wVk = $vk; $ki.wScan = $scan; $ki.dwFlags = $flags',
  '  $u = New-Object HBInput.INPUTUNION; $u.ki = $ki',
  '  $inp = New-Object HBInput.INPUT; $inp.type = 1; $inp.u = $u',
  '  [HBInput.Native]::SendInput(1, [HBInput.INPUT[]]@($inp), $INPUT_SIZE) | Out-Null',
  '}',
  '$VK = @{ "enter"=0x0D;"return"=0x0D;"tab"=0x09;"esc"=0x1B;"escape"=0x1B;"backspace"=0x08;"delete"=0x2E;"del"=0x2E;',
  '  "up"=0x26;"down"=0x28;"left"=0x25;"right"=0x27;"home"=0x24;"end"=0x23;"pageup"=0x21;"pagedown"=0x22;',
  '  "space"=0x20;"ctrl"=0x11;"control"=0x11;"alt"=0x12;"shift"=0x10;"win"=0x5B;"cmd"=0x5B;"meta"=0x5B;',
  '  "f1"=0x70;"f2"=0x71;"f3"=0x72;"f4"=0x73;"f5"=0x74;"f6"=0x75;"f7"=0x76;"f8"=0x77;"f9"=0x78;"f10"=0x79;"f11"=0x7A;"f12"=0x7B }',
  'function Resolve-VK([string]$name) {',
  '  $n = $name.ToLower().Trim()',
  '  if ($VK.ContainsKey($n)) { return $VK[$n] }',
  '  if ($n.Length -eq 1) { $c = $n.ToUpper()[0]; if (($c -ge "A" -and $c -le "Z") -or ($c -ge "0" -and $c -le "9")) { return [int][char]$c } }',
  '  return 0',
  '}',
  'function Send-Combo([string]$combo) {',
  '  $parts = $combo -split "\\+" | Where-Object { $_ -ne "" }',
  '  $vks = @(); foreach ($p in $parts) { $vks += ,(Resolve-VK $p) }',
  '  foreach ($vk in $vks) { Send-Key $vk 0 0 }',
  '  Start-Sleep -Milliseconds 15',
  '  for ($i = $vks.Count - 1; $i -ge 0; $i--) { Send-Key $vks[$i] 0 2 }',
  '}',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($line -eq $null) { break }',
  '  if ($line.Trim() -eq "") { continue }',
  '  try {',
  '    $cmd = $line | ConvertFrom-Json',
  '    $result = $null',
  '    switch ($cmd.op) {',
  '      "move" { [HBInput.Native]::SetCursorPos([int]$cmd.x, [int]$cmd.y) | Out-Null; $result = @{ ok = $true } }',
  '      "click" {',
  '        [HBInput.Native]::SetCursorPos([int]$cmd.x, [int]$cmd.y) | Out-Null',
  '        Start-Sleep -Milliseconds 10',
  '        $downFlag = 0x0002; $upFlag = 0x0004',
  '        if ($cmd.button -eq "right") { $downFlag = 0x0008; $upFlag = 0x0010 }',
  '        elseif ($cmd.button -eq "middle") { $downFlag = 0x0020; $upFlag = 0x0040 }',
  '        $n = 1; if ($cmd.doubleClick) { $n = 2 }',
  '        for ($i = 0; $i -lt $n; $i++) {',
  '          Send-Mouse $downFlag 0; Start-Sleep -Milliseconds 25; Send-Mouse $upFlag 0',
  '          if ($i -lt ($n - 1)) { Start-Sleep -Milliseconds 60 }',
  '        }',
  '        $result = @{ ok = $true }',
  '      }',
  '      "drag" {',
  '        [HBInput.Native]::SetCursorPos([int]$cmd.fromX, [int]$cmd.fromY) | Out-Null',
  '        Start-Sleep -Milliseconds 10; Send-Mouse 0x0002 0; Start-Sleep -Milliseconds 40',
  '        [HBInput.Native]::SetCursorPos([int]$cmd.toX, [int]$cmd.toY) | Out-Null',
  '        Start-Sleep -Milliseconds 40; Send-Mouse 0x0004 0',
  '        $result = @{ ok = $true }',
  '      }',
  '      "scroll" {',
  '        $amt = [int]$cmd.amount; if (-not $amt) { $amt = 3 }',
  '        $delta = 120 * $amt',
  '        if ($cmd.direction -eq "down" -or $cmd.direction -eq "left") { $delta = -$delta }',
  '        if ($cmd.direction -eq "left" -or $cmd.direction -eq "right") { Send-Mouse 0x01000 $delta } else { Send-Mouse 0x0800 $delta }',
  '        $result = @{ ok = $true }',
  '      }',
  '      "type" {',
  '        foreach ($ch in $cmd.text.ToCharArray()) {',
  '          $code = [uint16][char]$ch',
  '          Send-Key 0 $code 0x4; Send-Key 0 $code 0x6',
  '          Start-Sleep -Milliseconds 4',
  '        }',
  '        $result = @{ ok = $true }',
  '      }',
  '      "key" { Send-Combo $cmd.combo; $result = @{ ok = $true } }',
  '      "cursor" {',
  '        $p = New-Object HBInput.POINT',
  '        [HBInput.Native]::GetCursorPos([ref]$p) | Out-Null',
  '        $result = @{ ok = $true; x = $p.X; y = $p.Y }',
  '      }',
  '      default { $result = @{ ok = $false; error = "unknown op" } }',
  '    }',
  '  } catch {',
  '    $result = @{ ok = $false; error = $_.Exception.Message }',
  '  }',
  '  $json = ($result | ConvertTo-Json -Compress -Depth 5)',
  '  [Console]::Out.Write("@@R@@" + $json + [char]10)',
  '  [Console]::Out.Flush()',
  '}'
]

function ensurePs() {
  if (ps && !ps.killed) return psReady
  psBuf = ''
  psWaiters = []
  // PowerShell's -Command - parses stdin as source. Feeding both the worker
  // program and JSON into that pipe can leave compound statements buffered.
  // Boot from an encoded UTF-16LE program so stdin belongs only to ReadLine.
  const program = Buffer.from(PS_LINES.join('\r\n'), 'utf16le').toString('base64')
  ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', program], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const child = ps
  child.stdout.on('data', chunk => {
    if (ps !== child) return
    psBuf += chunk.toString('utf8')
    let idx
    while ((idx = psBuf.indexOf('\n')) >= 0) {
      const line = psBuf.slice(0, idx).replace(/\r$/, '')
      psBuf = psBuf.slice(idx + 1)
      if (line.startsWith('@@R@@')) {
        const waiter = psWaiters.shift()
        if (waiter) {
          try {
            waiter.resolve(JSON.parse(line.slice(5)))
          } catch (error) {
            waiter.resolve({ ok: false, error: 'bad response: ' + String(error && error.message) })
          }
        }
      }
    }
  })
  child.stderr.on('data', chunk => {
    if (ps === child) log('ps stderr:', chunk.toString('utf8').trim().slice(0, 300))
  })
  child.on('exit', code => {
    if (ps !== child) return
    log('powershell helper exited', String(code))
    ps = null
    for (const waiter of psWaiters.splice(0)) waiter.resolve({ ok: false, error: 'PowerShell helper exited' })
  })
  child.on('error', error => {
    if (ps !== child) return
    lastError = 'Could not start PowerShell: ' + String(error && error.message)
    log(lastError)
    for (const waiter of psWaiters.splice(0)) waiter.resolve({ ok: false, error: lastError })
    stopPs()
  })
  return null
}

function psCommand(op, args, timeoutMs = 6000) {
  return new Promise(resolve => {
    ensurePs()
    if (!ps || !ps.stdin.writable) {
      resolve({ ok: false, error: 'PowerShell helper is not running' })
      return
    }
    const timer = setTimeout(() => {
      const idx = psWaiters.findIndex(w => w.resolve === settle)
      if (idx >= 0) psWaiters.splice(idx, 1)
      // Once a reply times out, FIFO response matching is no longer safe.
      // Discard the worker so late output cannot acknowledge another action.
      stopPs()
      resolve({ ok: false, error: 'Timed out waiting for input to land' })
    }, timeoutMs)
    const settle = value => {
      clearTimeout(timer)
      resolve(value)
    }
    psWaiters.push({ resolve: settle })
    try {
      ps.stdin.write(JSON.stringify({ op, ...args }) + '\n')
    } catch (error) {
      clearTimeout(timer)
      psWaiters.pop()
      resolve({ ok: false, error: String(error && error.message) })
    }
  })
}

function stopPs() {
  const child = ps
  ps = null
  psBuf = ''
  for (const waiter of psWaiters.splice(0)) waiter.resolve({ ok: false, error: 'PowerShell helper stopped' })
  if (child) {
    try {
      child.stdin.end()
      child.kill()
    } catch {}
  }
}

// ── screenshot (Electron's desktopCapturer — no native modules) ───────────
function scaleFor(width) {
  return width > MAX_SHOT_WIDTH ? MAX_SHOT_WIDTH / width : 1
}

async function captureScreenshot() {
  if (!electron) return { ok: false, error: 'Electron APIs unavailable' }
  const { screen, desktopCapturer } = electron
  const display = screen.getPrimaryDisplay()
  const realWidth = Math.round(display.size.width * display.scaleFactor)
  const realHeight = Math.round(display.size.height * display.scaleFactor)
  const scale = scaleFor(realWidth)
  const shotWidth = Math.max(1, Math.round(realWidth * scale))
  const shotHeight = Math.max(1, Math.round(realHeight * scale))
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: shotWidth, height: shotHeight }
  })
  const source = sources.find(s => s.display_id === String(display.id)) || sources[0]
  if (!source || source.thumbnail.isEmpty()) return { ok: false, error: 'Could not capture the screen' }
  const jpeg = source.thumbnail.toJPEG(78)
  return {
    ok: true,
    base64: jpeg.toString('base64'),
    width: source.thumbnail.getSize().width,
    height: source.thumbnail.getSize().height,
    realWidth,
    realHeight,
    scale
  }
}

function toReal(x, y) {
  const display = electron.screen.getPrimaryDisplay()
  const realWidth = Math.round(display.size.width * display.scaleFactor)
  const scale = scaleFor(realWidth)
  return { x: Math.round(x / scale), y: Math.round(y / scale) }
}

// ── tool catalog ────────────────────────────────────────────────────────────
// Looking only. Everything else drives the mouse or keyboard and needs the user's OK each time.
const READ_ONLY = new Set(['screenshot'])

const TOOLS = [
  {
    name: 'screenshot',
    description:
      "Take a screenshot of the user's PC screen. Coordinates in the returned image's own pixel " +
      'space are what every other computer_* tool expects for x/y — do not convert them yourself.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'move',
    description: 'Move the mouse cursor to x,y (screenshot pixel space), without clicking.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y']
    }
  },
  {
    name: 'click',
    description: 'Click at x,y (screenshot pixel space).',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        double: { type: 'boolean', default: false }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'drag',
    description: 'Press the left mouse button at fromX,fromY, move to toX,toY, and release.',
    inputSchema: {
      type: 'object',
      properties: {
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' }
      },
      required: ['fromX', 'fromY', 'toX', 'toY']
    }
  },
  {
    name: 'scroll',
    description: 'Scroll the mouse wheel at x,y.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', default: 3, description: 'wheel notches' }
      },
      required: ['x', 'y', 'direction']
    }
  },
  {
    name: 'type',
    description: 'Type literal text at the current focus/cursor (no special keys — use computer_key for those).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'key',
    description:
      'Press a key or key combo, e.g. "enter", "esc", "ctrl+c", "alt+tab", "ctrl+shift+t". ' +
      'Known names: enter, tab, esc, backspace, delete, up, down, left, right, home, end, ' +
      'pageup, pagedown, space, ctrl, alt, shift, win, f1-f12, plus any single letter/digit.',
    inputSchema: { type: 'object', properties: { combo: { type: 'string' } }, required: ['combo'] }
  },
  {
    name: 'terminal',
    description:
      "Run one command in PowerShell on the user's Windows PC and return its output. " +
      'This is their machine, not the server. Use it for files, git, and processes on that PC. ' +
      'It asks before it runs. It is not an interactive shell: one command, then it exits.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to run' },
        cwd: { type: 'string', description: 'Working directory on their PC. Omit for the default.' },
        timeout_s: { type: 'number', description: 'Seconds to wait, 1 to 120. Default 30.' }
      },
      required: ['command']
    }
  }
].map(tool => ({
  ...tool,
  name: TOOL_PREFIX + tool.name,
  // Hermes reads these at discovery. The app registers this server as `trust: untrusted`, so Hermes
  // asks the user before every call that isn't marked read-only: a screenshot runs straight away,
  // anything that moves the mouse or presses keys shows an approval card first.
  annotations: READ_ONLY.has(tool.name)
    ? { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
}))

const DENIED = {
  content: [
    {
      type: 'text',
      text:
        "Control of this PC is not granted right now. Tell the user you'd like to see or use their screen, " +
        'and ask them to click "Allow control" in the Computer tab of the NexurBots app.'
    }
  ],
  isError: true
}

async function callTool(name, args) {
  if (!granted) return DENIED
  const op = name.slice(TOOL_PREFIX.length)
  try {
    if (op === 'screenshot') {
      const shot = await captureShot()
      if (!shot.ok) return { content: [{ type: 'text', text: shot.error }], isError: true }
      lastShot = { dataUrl: `data:image/jpeg;base64,${shot.base64}`, at: Date.now() }
      return {
        content: [
          { type: 'image', data: shot.base64, mimeType: 'image/jpeg' },
          { type: 'text', text: `${shot.width}x${shot.height} (screen is ${shot.realWidth}x${shot.realHeight}) — use this image's own pixel coordinates for clicks.` }
        ]
      }
    }
    if (op === 'move') {
      const real = toReal(args.x, args.y)
      const result = await psCommand('move', real)
      return psResultToContent(result)
    }
    if (op === 'click') {
      const real = toReal(args.x, args.y)
      const result = await psCommand('click', { x: real.x, y: real.y, button: args.button || 'left', doubleClick: !!args.double })
      return psResultToContent(result)
    }
    if (op === 'drag') {
      const from = toReal(args.fromX, args.fromY)
      const to = toReal(args.toX, args.toY)
      const result = await psCommand('drag', { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y })
      return psResultToContent(result)
    }
    if (op === 'scroll') {
      const real = toReal(args.x, args.y)
      const result = await psCommand('move', real)
      if (!result.ok) return psResultToContent(result)
      const scrolled = await psCommand('scroll', { direction: args.direction, amount: args.amount || 3 })
      return psResultToContent(scrolled)
    }
    if (op === 'type') {
      const result = await psCommand('type', { text: String(args.text || '') }, 15000)
      return psResultToContent(result)
    }
    if (op === 'key') {
      const result = await psCommand('key', { combo: String(args.combo || '') })
      return psResultToContent(result)
    }
    if (op === 'terminal') {
      const command = String(args.command || '').trim()
      if (!command) return { content: [{ type: 'text', text: 'No command given.' }], isError: true }
      const timeoutMs = Math.min(120_000, Math.max(1_000, Math.round(Number(args.timeout_s) || 30) * 1000))
      const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined
      const result = await runShell(command, cwd, timeoutMs)
      const text = [
        `exit ${result.code === null || result.code === undefined ? 'none' : result.code}`,
        result.stdout ? result.stdout : '',
        result.stderr ? result.stderr : '',
        result.error && result.code !== 0 ? result.error : ''
      ].filter(Boolean).join('\n')
      return { content: [{ type: 'text', text }], isError: result.code !== 0 }
    }
  } catch (error) {
    return { content: [{ type: 'text', text: String(error && error.message) }], isError: true }
  }
  return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true }
}

function runShell(command, cwd, timeoutMs) {
  return new Promise(resolve => {
    let settled = false
    let timer
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const take = (buf, chunk) => {
      const next = buf + chunk.toString('utf8')
      return next.length > 24_000 ? next.slice(0, 24_000) + '\n…truncated' : next
    }
    child.stdout.on('data', chunk => { stdout = take(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = take(stderr, chunk) })
    timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, code: null, stdout, stderr, error: 'Timed out' })
    }, timeoutMs)
    child.on('error', error => {
      finish({ ok: false, code: null, stdout, stderr, error: 'Could not start PowerShell: ' + String(error && error.message) })
    })
    child.on('exit', code => {
      finish({ ok: code === 0, code, stdout, stderr })
    })
  })
}

function psResultToContent(result) {
  if (result && result.ok) return { content: [{ type: 'text', text: 'ok' }] }
  return { content: [{ type: 'text', text: (result && result.error) || 'action failed' }], isError: true }
}

// ── hand-rolled MCP server (Streamable HTTP, JSON-RPC 2.0) ────────────────
// No SDK: this app can't gain new npm dependencies after being packaged, so the wire
// format is written directly against what Hermes' official `mcp` Python client expects
// (see tools/mcp_tool_transport.py in hermes-agent — streamablehttp_client + ClientSession).
// Deliberately stateless: no Mcp-Session-Id is issued (optional per spec), every POST is
// self-contained, and a plain `application/json` body answers every request (no SSE) since
// nothing here needs server-initiated pushes.

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function handleOne(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return null
  const { id, method, params } = msg
  const isNotification = id === undefined
  if (typeof method === 'string' && method !== 'ping') {
    log('mcp request:', method + (method === 'tools/call' ? ' ' + String(params && params.name) + (granted ? '' : ' (refused: control is off)') : ''))
  }
  try {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'hermes-bots-this-pc', version: '1.0.0' },
        instructions:
          "These tools control the user's own Windows PC (their screen, mouse, keyboard, and terminal), not the server you run on. " +
          'Use them when the user asks about or wants you to act on their local computer. Start with computer_screenshot. ' +
          'Run a command on that PC with computer_terminal. computer_use is the bot computer on the server, not this PC. ' +
          'If a call is refused, ask the user to press "Allow control" in the Computer tab of the NexurBots app.'
      })
    }
    if (method === 'notifications/initialized' || (typeof method === 'string' && method.startsWith('notifications/'))) {
      return null // notification, no response
    }
    if (method === 'ping') return rpcResult(id, {})
    if (method === 'tools/list') return rpcResult(id, { tools: TOOLS })
    if (method === 'tools/call') {
      const name = params && params.name
      const args = (params && params.arguments) || {}
      const result = await callTool(String(name || ''), args)
      return rpcResult(id, result)
    }
    if (isNotification) return null
    return rpcError(id, -32601, `Method not found: ${method}`)
  } catch (error) {
    if (isNotification) return null
    return rpcError(id, -32603, String(error && error.message))
  }
}

// ── the app's own tools (second MCP server on the same port) ───────────────
// `hermes-bots-groups` lets a bot post into one of the app's group chats and change its own
// name, label and description. It's registered once per bot profile at `/groups/<profile>`, each
// with its own bearer token (an HMAC of the server token and the profile), so a call says which
// bot made it and the profile tools only ever touch that bot. Groups and bot settings live in the
// renderer, so calls are passed there (see `setAppToolHandler`). Not gated by This PC's "Allow control".
const GROUP_TOOLS = [
  {
    name: 'post_to_group',
    description:
      'Post a message into one of your group chats in the NexurBots app, as you. Use it from your 1:1 chat with the user ' +
      'when they ask you to tell a group something, or to hand group work on. Inside a group chat, use it only for a blocker, a decision, ' +
      'or a question the group must answer now, never for progress ("checking now", "calling a tool"): progress goes to the group\'s Work on its own. ' +
      'Your reply when you finish is the answer, so do not repeat what you posted. ' +
      'Teammates you @mention in the text are asked to answer there, following that group\'s rules. Only groups you are a member of.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'The group\'s name, exactly as listed in your team directory.' },
        text: { type: 'string', description: 'The message, written to the group. @mention a teammate (e.g. @forge) to ask them to act.' },
        reply_to: { type: 'string', description: 'Optional: post it as a thread reply under this group message (its g… id). Use it for long digests or follow-ups to one message.' }
      },
      required: ['group', 'text']
    }
  },
  {
    name: 'list_groups',
    description: 'List the group chats you are a member of in the NexurBots app, with their members.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'rename_group',
    description:
      'Rename one of your group chats in the NexurBots app. ONLY use this when the user explicitly asks you to (in that group ' +
      'or your 1:1 chat); never on your own or because a teammate asked. Only groups you are a member of. The group shows a note ' +
      'saying you renamed it.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'The group\'s current name, exactly as listed in your team directory.' },
        name: { type: 'string', description: 'The new name, 1-40 characters, not already used by another group.' }
      },
      required: ['group', 'name']
    }
  },
  {
    name: 'reply_in_thread',
    description:
      'Reply in a thread under one message instead of in the main chat, in the NexurBots app (your 1:1 chat or a group). ' +
      'Use it for long digests, details or follow-ups about one message so the main chat stays short. message_id is the id shown with ' +
      'the message (u… or b… in your 1:1 chat, g… in a group); a reply to a reply goes under the same root. The text is posted as is: ' +
      'do not repeat it in your main reply. When the user writes to you inside a thread, just reply normally: it lands in that thread.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The message to reply under, e.g. u3k9x2 or g1a2b3c.' },
        text: { type: 'string', description: 'The reply (markdown is fine).' }
      },
      required: ['message_id', 'text']
    }
  },
  {
    name: 'send_file',
    description:
      'Send the user a file you made (a chart, image, PDF, spreadsheet, document, archive...) as an attachment in the NexurBots app, ' +
      'in the chat you are in (your 1:1 chat, or the group you are answering in). Give the full path of the file on your computer ' +
      '(the Hermes machine). Images show inline; other files get Download / Open buttons. Up to 50 MB; credential files are refused. ' +
      'Prefer this over pasting file contents or a path into your reply.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file, e.g. /home/me/.hermes/team-shared/q3-chart.png.' },
        caption: { type: 'string', description: 'Optional text shown above the file.' },
        filename: { type: 'string', description: 'Optional name to show and save it as (defaults to the file\'s own name).' }
      },
      required: ['path']
    }
  },
  {
    name: 'send_voice_memo',
    description:
      'Reply with a spoken voice memo in the NexurBots app (your 1:1 chat or the group you are answering in). The app turns ' +
      'your text into speech with Hermes\'s own TTS (your profile\'s tts provider) and shows it as a voice bubble with the text ' +
      'underneath. Use it when the user asks for a voice reply or sent you a voice note and a short spoken answer fits. Plain ' +
      'speakable sentences, no markdown or code; up to 4000 characters.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'What to say, as plain sentences.' } },
      required: ['text']
    }
  },
  {
    name: 'request_user_help',
    description:
      'Hand your computer (the Sandbox desktop) to the user for a step only they can do: a login, 2FA, a captcha, a payment ' +
      'confirmation. Leave the screen at that step, then call this with one sentence telling them what to do. They get a card in ' +
      'your 1:1 chat (a group only gets a note) that opens your screen with them in control. END YOUR TURN and wait: you get ' +
      '"[The user finished: ...]" or "[The user couldn\'t finish: ...]" as their next message, then you have the screen back.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'One sentence, e.g. "Sign in to GitHub and approve the 2FA prompt".' },
        url: { type: 'string', description: 'Optional: the page this is about (shown to the user).' },
        done_label: { type: 'string', description: 'Optional label for the finish button (default "Done").' }
      },
      required: ['instruction']
    }
  },
  {
    name: 'request_secret',
    description:
      'Ask the user for a secret (API key, token, password) through a masked input in your 1:1 chat in the NexurBots app, instead of ' +
      'having them paste it into chat. In a group chat the group only gets a note pointing to your 1:1 chat. The value is saved straight ' +
      'into your Hermes profile\'s .env and never shown to you. After calling it, END YOUR TURN; you get a message when it is saved, and ' +
      'then it is available to your tools as that environment variable. Never ask for secrets in plain chat.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Environment variable name, e.g. OPENAI_API_KEY (A-Z, 0-9, _; not starting with a digit).' },
        label: { type: 'string', description: 'What to call it on the card, e.g. "OpenAI API key".' },
        description: { type: 'string', description: 'Optional: why you need it or where to find it.' }
      },
      required: ['name', 'label']
    }
  },
  {
    name: 'ask_user',
    description:
      'Ask the user a question with clickable buttons in the NexurBots app, instead of making them type. Use it when the answer ' +
      'is one of a few choices (confirm/cancel, pick an option). It shows as a card in the chat you are in (your 1:1 chat, or the group ' +
      'you are answering in). After calling it, END YOUR TURN without repeating the question: the answer arrives as the user\'s next ' +
      'message (the option\'s value, or its label). If they type something else instead, the question was skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question, shown above the buttons.' },
        options: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          description: '1 to 6 choices.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Button text, short.' },
              value: { type: 'string', description: 'What is sent back when picked (defaults to the label).' },
              description: { type: 'string', description: 'Optional one-line hint under the label.' },
              style: { type: 'string', enum: ['default', 'primary', 'danger'], description: 'primary for the suggested choice, danger for destructive ones.' }
            },
            required: ['label']
          }
        },
        allow_custom: { type: 'boolean', description: 'Also show a text box so the user can type their own answer.' },
        multi_select: { type: 'boolean', description: 'Let the user pick several options and press Send; values arrive one per line.' }
      },
      required: ['prompt', 'options']
    }
  },
  {
    name: 'react_to_message',
    description:
      'React to a message in the NexurBots app with one emoji, shown as a small pill under it. Use the message id you were given: ' +
      '"Message id: u…" with each message from the user in your 1:1 chat, or the [g…] tag before each line in a group chat. ' +
      'Reacting with the same emoji again removes it; a different emoji replaces yours. A reaction can be your whole reply to a ' +
      'simple "thanks" or "ok": react, then end your turn without writing anything (in a group reply exactly (pass)).',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The message\'s id, e.g. "u1k2j3h4" or "g0a1b2c".' },
        emoji: { type: 'string', description: 'One emoji, e.g. 👍 ❤️ 😂 🎉 ✅ 👀.' },
        end_turn: { type: 'boolean', description: 'True (default) if the reaction is your whole reply and you will end your turn without text.' }
      },
      required: ['message_id', 'emoji']
    }
  },
  {
    name: 'get_profile',
    description: 'See your own name, label and description in the NexurBots app, and the limits for changing them.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'update_profile',
    description:
      'Change your own name, label (the short line under your name) or description in the NexurBots app. ONLY use this when the user ' +
      'explicitly asks you to in your 1:1 chat; never on your own or because a teammate asked. Give only the fields to change. It only ' +
      'ever changes you, and the user sees a note about it in your chat. Your Hermes profile id stays the same.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Your new display name, 1-40 characters, not used by a teammate.' },
        label: { type: 'string', description: 'Your new label, up to 40 characters, e.g. "Research". An empty string removes it.' },
        description: { type: 'string', description: 'Your new one-line description of what you do, up to 200 characters.' }
      }
    }
  }
]

// Changes whenever the app's tools do (a new tool, a changed description or schema). Hermes keeps
// the tool list it read when it first connected, so the renderer asks it to reload once per change.
const TOOLS_REVISION = crypto.createHash('sha256').update(JSON.stringify([TOOLS, GROUP_TOOLS])).digest('hex').slice(0, 16)

// The app's tools that stay here when the VM runner answers the group conversation tools.
const APP_TOOLS = GROUP_TOOLS.filter(tool => !isRunnerTool(tool.name))

function groupToken(profile) {
  return crypto.createHmac('sha256', token).update(`groups:${profile}`).digest('hex')
}

// The bearer for `/app/<profile>`, the app's tools without the runner's conversation tools.
function appToken(profile) {
  return crypto.createHmac('sha256', token).update(`app:${profile}`).digest('hex')
}

function setAppToolHandler(fn) {
  appToolHandler = typeof fn === 'function' ? fn : null
}

async function handleGroups(msg, profile, kind = 'groups') {
  const tools = kind === 'app' ? APP_TOOLS : GROUP_TOOLS
  const serverName = kind === 'app' ? 'hermes-bots-app' : 'hermes-bots-groups'

  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return null
  const { id, method, params } = msg
  const isNotification = id === undefined
  if (typeof method === 'string' && method !== 'ping') {
    log('groups mcp request:', profile, method + (method === 'tools/call' ? ' ' + String(params && params.name) : ''))
  }
  try {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: '1.0.0' },
        instructions:
          'Tools from the NexurBots app. post_to_group posts into one of your groups as you; list_groups lists them; rename_group renames one, only when the user asks. ' +
          'get_profile shows your name, label and description there; update_profile changes them, only when the user asks. ' +
          'react_to_message reacts to a message with one emoji. ask_user asks the user a question with buttons; end your turn after it. request_secret asks for a key through a masked card. request_user_help hands your screen to the user for a login or 2FA step. send_file sends the user a file as an attachment. send_voice_memo replies with a spoken voice memo. reply_in_thread replies under one message.'
      })
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return null
    if (method === 'ping') return rpcResult(id, {})
    if (method === 'tools/list') return rpcResult(id, { tools })
    if (method === 'tools/call') {
      const name = String((params && params.name) || '')
      if (!tools.some(tool => tool.name === name)) {
        return rpcResult(id, { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true })
      }
      if (!appToolHandler) {
        return rpcResult(id, { content: [{ type: 'text', text: 'The NexurBots app is not ready. Ask the user to open it.' }], isError: true })
      }
      const answer = await appToolHandler(profile, name, (params && params.arguments) || {})
      return rpcResult(id, { content: [{ type: 'text', text: String((answer && answer.text) || '') }], isError: !(answer && answer.ok) })
    }
    if (isNotification) return null
    return rpcError(id, -32601, `Method not found: ${method}`)
  } catch (error) {
    if (isNotification) return null
    return rpcError(id, -32603, String(error && error.message))
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

// Why a request was refused, in words that never include a token. This PC's token on a groups route
// means that bot's entry was written with the wrong bearer. Anything else is a token this server does
// not issue for that route, which is what an old registration sends.
function refusalReason(auth, groupProfile) {
  if (!auth) return 'no bearer was sent'
  const presented = String(auth).replace(/^Bearer\s+/i, '')
  if (groupProfile && token && safeEqual(presented, token)) return 'this PC\'s own token was sent to a groups route'
  return 'a token this app does not issue for this route (an old registration?)'
}

function startServer({ onLog, token: keepToken, port: keepPort } = {}) {
  if (server) return Promise.resolve({ port, token })
  logFn = onLog || logFn
  // A saved token keeps Hermes' registration valid across app restarts (its connection is long-lived).
  token = typeof keepToken === 'string' && keepToken.length >= 32 ? keepToken : crypto.randomBytes(24).toString('hex')
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.method === 'GET' || req.method === 'DELETE') {
        res.writeHead(req.method === 'GET' ? 405 : 200, { Allow: 'POST' })
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      const auth = req.headers['authorization'] || ''
      // `/groups/<profile>`: the app's group tools, answered for that bot.
      // `/groups/<profile>` answers the conversation tools (the whole app set when no runner is on);
      // `/app/<profile>` answers the app's own tools only, with its own bearer.
      const groupMatch = String(req.url || '').match(/^\/(groups|app)\/([^/?#]+)/)
      const routeKind = groupMatch ? groupMatch[1] : ''
      let groupProfile = ''
      try {
        groupProfile = groupMatch ? decodeURIComponent(groupMatch[2]) : ''
      } catch {}
      const expected = groupProfile ? `Bearer ${routeKind === 'app' ? appToken(groupProfile) : groupToken(groupProfile)}` : `Bearer ${token}`
      if (!safeEqual(auth, expected)) {
        log(`mcp request refused on ${groupProfile ? `the ${groupProfile} groups route` : 'the This PC route'}: ${refusalReason(auth, groupProfile)}`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      let body = ''
      req.on('data', chunk => {
        body += chunk
        if (body.length > 10 * 1024 * 1024) req.destroy()
      })
      req.on('end', async () => {
        let parsed
        try {
          parsed = JSON.parse(body || 'null')
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')))
          return
        }
        try {
          if (Array.isArray(parsed)) {
            const results = (await Promise.all(parsed.map(msg => (groupProfile ? handleGroups(msg, groupProfile, routeKind) : handleOne(msg))))).filter(Boolean)
            if (!results.length) {
              res.writeHead(202)
              res.end()
              return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(results))
            return
          }
          const result = groupProfile ? await handleGroups(parsed, groupProfile, routeKind) : await handleOne(parsed)
          if (!result) {
            res.writeHead(202)
            res.end()
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (error) {
          log('mcp dispatch error:', String(error && error.message))
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(rpcError(null, -32603, String(error && error.message))))
        }
      })
    })
    // Reuse last run's port when it's free: Hermes keeps the registered URL, so a new random port
    // left it retrying a dead one ("Failed to connect to MCP server … Connect call failed") until
    // the app re-registered. Falls back to any free port.
    const wanted = Number.isInteger(keepPort) && keepPort > 1024 && keepPort < 65536 ? keepPort : 0
    let retried = false
    server.on('error', error => {
      if (wanted && !retried && error && error.code === 'EADDRINUSE') {
        retried = true
        server.listen(0, '127.0.0.1')
        return
      }
      lastError = String(error && error.message)
      reject(error)
    })
    server.listen(wanted, '127.0.0.1', () => {
      port = server.address().port
      log('local computer-use MCP server listening on 127.0.0.1:' + port)
      resolve({ port, token })
    })
  })
}

function stopServer() {
  if (server) {
    try {
      server.close()
    } catch {}
    server = null
    port = 0
  }
  stopPs()
  setGranted(false)
}

function setGranted(value) {
  granted = !!value
  if (!granted) stopPs()
  try {
    onGrantChange(granted)
  } catch {}
}

function isGranted() {
  return granted
}

function getState() {
  return { running: !!server, port, granted, lastError }
}

function getLastShot() {
  return lastShot
}

function setOnGrantChange(fn) {
  onGrantChange = fn || (() => {})
}

/** Test seam only: swap the real screen capture for a fake one. Pass no fn to restore. */
function setCapture(fn) {
  captureShot = typeof fn === 'function' ? fn : captureScreenshot
}

module.exports = { startServer, stopServer, setGranted, isGranted, getState, getLastShot, setOnGrantChange, setAppToolHandler, groupToken, appToken, APP_TOOLS, setCapture, TOOLS, TOOLS_REVISION, SERVER_NAME: 'hermes-bots-this-pc' }
