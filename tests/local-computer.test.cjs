'use strict'
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const childProcess = require('node:child_process')
const { test } = require('node:test')

function fakePowerShell(command, args) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.stdin = {
    writable: true,
    write(data) {
      // -Command - owns stdin as source input, so the helper's ReadLine loop
      // cannot safely share it with JSON-RPC input. Emulate that real boundary.
      if (args.includes('-Command')) {
        queueMicrotask(() => child.emit('exit', 1))
        return true
      }
      const request = JSON.parse(data)
      assert.equal(request.op, 'key')
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('@@R@@{"ok":true}\n')))
      return true
    },
    end() { this.writable = false }
  }
  child.kill = () => { child.killed = true; child.emit('exit', 0) }
  assert.equal(command, 'powershell.exe')
  return child
}

async function fixture(t, spawnImpl = fakePowerShell) {
  const spawn = t.mock.method(childProcess, 'spawn', spawnImpl)
  const modulePath = require.resolve('../electron/local-computer.cjs')
  delete require.cache[modulePath]
  const bridge = require(modulePath)
  bridge.setActionApprovalHandler(async () => true)
  const { port, token } = await bridge.startServer()
  t.after(() => { bridge.stopServer(); delete require.cache[modulePath] })
  const call = async (name, arguments_ = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } })
    })
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  return { bridge, spawn, call }
}

test('keyboard input uses an encoded startup program, leaving stdin for commands', async t => {
  const { bridge, spawn, call } = await fixture(t)
  bridge.setGranted(true)
  const result = await call('computer_key', { combo: 'shift' })
  assert.notEqual(result.isError, true, JSON.stringify(result))
  const [command, args] = spawn.mock.calls[0].arguments
  assert.equal(command, 'powershell.exe')
  assert(args.includes('-EncodedCommand'), 'startup code must not consume the command pipe')
  assert(!args.includes('-Command'))
  const program = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
  assert(program.includes('[Console]::In.ReadLine()'), 'worker must read JSON from stdin')
  assert(program.includes('Add-Type'), 'native input definitions must still initialize')
})

test('control-off refuses input without spawning a PowerShell process', async t => {
  const { spawn, call } = await fixture(t)
  const result = await call('computer_key', { combo: 'shift' })
  assert.equal(result.isError, true)
  assert.equal(spawn.mock.callCount(), 0)
})

test('PowerShell spawn errors return their cause without waiting for input timeout', async t => {
  const { bridge, call } = await fixture(t, (command, args) => {
    const child = fakePowerShell(command, args)
    child.stdin.write = () => {
      queueMicrotask(() => child.emit('error', new Error('spawn powershell.exe ENOENT')))
      return true
    }
    return child
  })
  bridge.setGranted(true)
  const result = await Promise.race([
    call('computer_key', { combo: 'shift' }),
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 500))
  ])
  assert.equal(result.isError, true, JSON.stringify(result))
  assert.match(result.content[0].text, /Could not start PowerShell.*ENOENT/)
})

// The helper's own input timeout is 6s (electron/local-computer.cjs: psCommand default), so the
// timeout this test waits for happens after 6 real seconds. Bun's default per-test budget is 5s,
// which killed the test before its own code path finished — it failed on every run, and left an
// open server that broke the NEXT suite's afterEach with "Cannot call afterEach() after the test
// run has completed". The budget has to cover the timeout under test.
test('a timed-out worker is discarded before accepting another input command', { timeout: 20_000 }, async t => {
  let created = 0
  const { bridge, spawn, call } = await fixture(t, (command, args) => {
    const child = fakePowerShell(command, args)
    if (++created === 1) {
      let writes = 0
      child.stdin.write = () => {
        if (++writes > 1) queueMicrotask(() => child.stdout.emit('data', Buffer.from('@@R@@{"ok":false,"error":"late reply from timed-out command"}\n')))
        return true
      }
    }
    return child
  })
  bridge.setGranted(true)
  const first = await call('computer_key', { combo: 'shift' })
  assert.equal(first.isError, true)
  assert.match(first.content[0].text, /Timed out/)
  const second = await call('computer_key', { combo: 'shift' })
  assert.notEqual(second.isError, true, JSON.stringify(second))
  assert.equal(spawn.mock.callCount(), 2)
})

test('revoking control kills the helper and cancels an in-flight command', async t => {
  let signalWritten
  const written = new Promise(resolve => { signalWritten = resolve })
  let child
  const { bridge, call } = await fixture(t, (command, args) => {
    child = fakePowerShell(command, args)
    child.stdin.write = () => { signalWritten(); return true }
    return child
  })
  bridge.setGranted(true)
  const pending = call('computer_key', { combo: 'shift' })
  await written
  bridge.setGranted(false)
  assert.equal(child.killed, true, 'revoked control must not leave queued input running')
  assert.equal((await pending).isError, true)
  const refused = await call('computer_key', { combo: 'shift' })
  assert.equal(refused.isError, true)
})

if (process.platform === 'win32') {
  test('real Windows PowerShell compiles the helper and replies to two stdin commands', { timeout: 240_000 }, async t => {
    // The helper's own first reply has a 15s wait, and on a cold windows-latest runner the first
    // Add-Type compile (PowerShell start + C# compiler) has blown it. So, test-side only:
    // 1. Warm up PowerShell and the C# compiler with a throwaway Add-Type, waiting up to 120s.
    // 2. If the first round of commands still times out, run the round once more (a timed-out
    //    helper is discarded, so the retry starts a fresh, now-warm one). A helper that never
    //    answers still fails, with the first error.
    const warm = await new Promise(resolve => {
      childProcess.execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -TypeDefinition 'namespace HBWarm { public class W { public static int Ping() { return 1; } } }'; [HBWarm.W]::Ping()"],
        { timeout: 120_000, windowsHide: true },
        (error, stdout) => resolve(error ? `warm-up failed: ${error.message}` : String(stdout).trim())
      )
    })
    t.diagnostic(`PowerShell warm-up: ${warm}`)
    const modulePath = require.resolve('../electron/local-computer.cjs')
    delete require.cache[modulePath]
    const bridge = require(modulePath)
    bridge.setActionApprovalHandler(async () => true)
    const { port, token } = await bridge.startServer()
    t.after(() => { bridge.stopServer(); delete require.cache[modulePath] })
    bridge.setGranted(true)
    const round = async () => {
      for (const id of [1, 2]) {
        const response = await fetch(`http://127.0.0.1:${port}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'computer_type', arguments: { text: '' } } })
        })
        const body = await response.json()
        assert.notEqual(body.result.isError, true, JSON.stringify(body))
      }
    }
    try {
      await round()
    } catch (error) {
      // Only a slow first reply earns a retry; any other failure is real.
      if (!/Timed out waiting for input to land/.test(String(error && error.message))) throw error
      t.diagnostic(`first round timed out, retrying once: ${error.message}`)
      await round().catch(() => { throw error })
    }
  })
}

test('a terminal command runs in its own PowerShell and returns the output', async t => {
  const { bridge, spawn, call } = await fixture(t, (command, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { writable: true, write() { return true }, end() {} }
    child.killed = false
    child.kill = () => { child.killed = true }
    assert.equal(command, 'powershell.exe')
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
    assert.equal(args[3], 'Get-Location')
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('C:\\Users\\you\n'))
      child.emit('exit', 0)
    })
    return child
  })
  bridge.setGranted(true)
  const result = await call('computer_terminal', { command: 'Get-Location', cwd: 'C:\\Users\\you' })
  assert.notEqual(result.isError, true, JSON.stringify(result))
  assert.match(result.content[0].text, /exit 0/)
  assert.match(result.content[0].text, /C:\\Users\\you/)
  assert.equal(spawn.mock.calls[0].arguments[2].cwd, 'C:\\Users\\you')
})

test('terminal is refused while control is off', async t => {
  const { spawn, call } = await fixture(t)
  const result = await call('computer_terminal', { command: 'Get-Location' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /not granted/)
  assert.equal(spawn.mock.callCount(), 0)
})

test('only the screenshot is marked read-only, so Hermes asks before every input action', async t => {
  const { bridge } = await fixture(t)
  const { port, token } = await bridge.startServer()
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })
  const { tools } = (await response.json()).result
  const readOnly = Object.fromEntries(tools.map(tool => [tool.name, tool.annotations && tool.annotations.readOnlyHint]))
  assert.deepEqual(readOnly, {
    computer_screenshot: true,
    computer_move: false,
    computer_click: false,
    computer_drag: false,
    computer_scroll: false,
    computer_type: false,
    computer_key: false,
    computer_terminal: false
  })
  assert.equal(bridge.SERVER_NAME, 'hermes-bots-this-pc')
})
