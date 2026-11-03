'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const http = require('node:http')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { setPanicShortcut } = require('../electron/panic-shortcut.cjs')

// An in-process transport exercises the real request handlers without opening a port.
function mockListener(t) {
  let handler
  t.mock.method(http, 'createServer', fn => {
    handler = fn
    const server = new EventEmitter()
    server.listen = (_port, _host, ready) => queueMicrotask(ready)
    server.address = () => ({ port: 12345 })
    server.close = done => { if (done) done() }
    return server
  })
  return (url, body, headers = {}) => new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url, headers })
    const res = {
      writeHead(status) { this.status = status; this.headersSent = true },
      end(text = '') { this.writableEnded = true; resolve({ status: this.status, text }) }
    }
    handler(req, res)
    req.emit('data', Buffer.from(body))
    req.emit('end')
  })
}

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => { child.killed = true; child.emit('exit', null) }
  return child
}

async function pcFixture(t, spawnImpl = () => fakeChild()) {
  const request = mockListener(t)
  const spawn = t.mock.method(childProcess, 'spawn', spawnImpl)
  const modulePath = require.resolve('../electron/local-computer.cjs')
  delete require.cache[modulePath]
  const pc = require(modulePath)
  const { token } = await pc.startServer({ token: 'a'.repeat(48) })
  t.after(() => { pc.stopServer(); delete require.cache[modulePath] })
  const call = (name, args = {}) => request('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), { authorization: `Bearer ${token}` })
    .then(result => JSON.parse(result.text).result)
  return { pc, spawn, call }
}

test('PC actions fail closed without local approval, and a denial never spawns a command', async t => {
  const { pc, spawn, call } = await pcFixture(t)
  pc.setGranted(true)
  assert.equal((await call('computer_terminal', { command: 'echo hello' })).isError, true)
  pc.setActionApprovalHandler(async () => false)
  assert.equal((await call('computer_terminal', { command: 'echo hello' })).isError, true)
  assert.equal(spawn.mock.callCount(), 0)
})

test('stale approval cannot authorize an action after Stop and re-enable', async t => {
  const { pc, spawn, call } = await pcFixture(t)
  let answer
  let asked
  const promptShown = new Promise(resolve => { asked = resolve })
  pc.setActionApprovalHandler(() => { asked(); return new Promise(resolve => { answer = resolve }) })
  pc.setGranted(true)
  const pending = call('computer_terminal', { command: 'echo hello' })
  await promptShown
  pc.setGranted(false)
  pc.setGranted(true)
  answer(true)
  assert.equal((await pending).isError, true)
  assert.equal(spawn.mock.callCount(), 0)
})

test('an approved action runs with the exact arguments shown for local confirmation', async t => {
  let shown
  const { pc, call } = await pcFixture(t, () => {
    const child = fakeChild()
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from('hello')); child.emit('exit', 0) })
    return child
  })
  pc.setActionApprovalHandler(async action => { shown = action; return true })
  pc.setGranted(true)
  const result = await call('computer_terminal', { command: 'echo hello' })
  assert.deepEqual(shown, { name: 'computer_terminal', args: { command: 'echo hello' } })
  assert.notEqual(result.isError, true)
  assert.match(result.content[0].text, /hello/)
})

test('screenshots work while control is on without authorizing input actions', async t => {
  const { pc, spawn, call } = await pcFixture(t)
  pc.setCapture(async () => ({ ok: true, base64: 'aGVsbG8=', width: 10, height: 10, realWidth: 10, realHeight: 10 }))
  pc.setGranted(true)
  assert.equal((await call('computer_screenshot')).content[0].type, 'image')
  assert.equal(spawn.mock.callCount(), 0)
})

test('Stop cancels an approved terminal command already in flight', async t => {
  let child
  let started
  const running = new Promise(resolve => { started = resolve })
  const { pc, call } = await pcFixture(t, () => { child = fakeChild(); started(); return child })
  pc.setActionApprovalHandler(async () => true)
  pc.setGranted(true)
  const pending = call('computer_terminal', { command: 'echo hello' })
  await running
  pc.setGranted(false)
  assert.equal(child.killed, true)
  const result = await pending
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Stopped when PC control was turned off/)
})

if (process.platform === 'win32') {
  test('Stop requests termination of the Windows process tree and falls back if it fails', async t => {
    let child
    let started
    const running = new Promise(resolve => { started = resolve })
    const { pc, spawn, call } = await pcFixture(t, command => {
      if (command === 'taskkill.exe') {
        const killer = new EventEmitter()
        queueMicrotask(() => killer.emit('exit', 1))
        return killer
      }
      child = fakeChild()
      child.pid = 12345
      started()
      return child
    })
    pc.setActionApprovalHandler(async () => true)
    pc.setGranted(true)
    const pending = call('computer_terminal', { command: 'echo hello' })
    await running
    pc.setGranted(false)
    await pending
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(spawn.mock.calls[1].arguments.slice(0, 2), ['taskkill.exe', ['/PID', '12345', '/T', '/F']])
    assert.equal(child.killed, true)
  })
}

test('panic shortcut reports an unavailable registration instead of enabling control silently', () => {
  let callback
  const shortcuts = { unregister() {}, register(_key, fn) { callback = fn; return false } }
  assert.equal(setPanicShortcut(shortcuts, true, () => {}), false)
  shortcuts.register = (_key, fn) => { callback = fn; return true }
  let stopped = false
  assert.equal(setPanicShortcut(shortcuts, true, () => { stopped = true }), true)
  callback()
  assert.equal(stopped, true)
})

test('a configured webhook secret that cannot be decrypted rejects events and test delivery', async t => {
  const request = mockListener(t)
  const hooks = require('../electron/hooks.cjs')
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.hook-test-'))
  const handlers = {}
  let delivered = 0
  let canDecrypt = false
  const server = hooks.init({
    app: { getPath: () => dir, whenReady: () => new Promise(() => {}) },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
    BrowserWindow: { getAllWindows: () => [{ webContents: { send() { delivered++ } } }] },
    seal: () => 'enc:stored',
    unseal: () => canDecrypt ? 'the-secret' : ''
  })
  t.after(async () => {
    await server.stop()
    try { fs.unlinkSync(path.join(dir, 'hooks.json')) } catch {}
    fs.rmdirSync(dir)
  })
  const { token } = await handlers['hooks:put']({}, { bot: 'a', routineId: 'r', kind: 'github', events: ['*'], secret: 'the-secret' })
  const body = '{}'
  assert.equal((await request(`/hooks/${token}`, body, { 'x-github-event': 'push' })).status, 503)
  assert.equal(delivered, 0)
  assert.equal((await handlers['hooks:test']({}, { token, event: 'push', body })).code, 503)
  canDecrypt = true
  assert.equal((await request(`/hooks/${token}`, body, { 'x-github-event': 'push' })).status, 401)
  const signature = 'sha256=' + crypto.createHmac('sha256', 'the-secret').update(body).digest('hex')
  assert.equal((await request(`/hooks/${token}`, body, { 'x-github-event': 'push', 'x-hub-signature-256': signature })).status, 202)
  assert.equal(delivered, 1)
})
