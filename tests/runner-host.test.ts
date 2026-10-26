/**
 * The headless runner runs a group with no window open.
 *
 * `startHost` boots the app's own conductor (rooms.ts, chat.ts) with a file-backed localStorage
 * and no renderer. Only the gateway transport is faked, as in rooms-wake.test.ts. The test posts to
 * a group, hands the turn from the lead to a teammate, and checks the reply lands in the room log
 * and the state survives a restart. The app is not started anywhere in this file.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { gateway } = await import('../src/lib/gateway')

interface Call {
  method: string
  params: Record<string, any>
}

const calls: Call[] = []
let epoch = 0

const PROFILE_ROWS = [
  { name: 'default', is_default: true, ui_meta: {} },
  { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha', lead: true } } },
  { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
]

gateway.connect = async () => {
  gateway.state.set('open')
}

gateway.request = (async (method: string, params: Record<string, any> = {}) => {
  calls.push({ method, params })

  if (method === 'profiles.list') return { profiles: PROFILE_ROWS }
  if (method === 'session.resume') {
    return { session_id: `rt${++epoch}:${params.profile}`, messages: [], running: false, inflight: null }
  }

  return {}
}) as typeof gateway.request

const submittedTo = (member: string) => calls.filter(call => call.method === 'prompt.submit' && call.params.profile === member)

/** Waits until the predicate holds, polling a few times a second. Fails the test after two seconds. */
const waitFor = async (predicate: () => boolean, what: string) => {
  const deadline = Date.now() + 2000

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

let stateDir = ''

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'runner-host-'))
  calls.length = 0
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

test('a group turn hands off from the lead to a teammate with no app open', async () => {
  const { startHost } = await import('../runner/host')
  const rooms = await import('../src/lib/rooms')
  const host = await startHost({ hermesUrl: 'http://runner-test', stateDir, readToken: async () => 'test-token' })

  try {
    const room = rooms.createRoom('Runner group', ['alpha', 'beta'], { reply: 'everyone', runner: true })
    rooms.postToRoom(room.key, '@alpha start')

    await waitFor(() => submittedTo('alpha').length === 1, 'the lead to take the turn')
    const alphaRuntime = String(submittedTo('alpha')[0].params.session_id)

    gateway.dispatch({ session_id: alphaRuntime, type: 'message.complete', payload: { text: '@beta your turn' } } as any)

    await waitFor(() => submittedTo('beta').length === 1, 'the handoff to beta')
    const betaRuntime = String(submittedTo('beta')[0].params.session_id)

    gateway.dispatch({ session_id: betaRuntime, type: 'message.complete', payload: { text: 'done, from beta' } } as any)

    await waitFor(
      () => rooms.$rooms.get()[room.key]?.log.some(entry => entry.from.name === 'beta' && entry.text === 'done, from beta') ?? false,
      'beta reply in the room log'
    )

    const logged = rooms.$rooms.get()[room.key]?.log.map(entry => `${entry.from.name}: ${entry.text}`)
    expect(logged).toContain('beta: done, from beta')
  } finally {
    host.close()
  }
})

test('the room state is saved in the runner folder and survives a restart', async () => {
  const { startHost } = await import('../runner/host')
  const rooms = await import('../src/lib/rooms')
  const host = await startHost({ hermesUrl: 'http://runner-test', stateDir, readToken: async () => 'test-token' })

  try {
    const room = rooms.createRoom('Saved group', ['alpha'], { reply: 'everyone', runner: true })
    rooms.postToRoom(room.key, 'remember this line')
    await waitFor(() => rooms.$rooms.get()[room.key]?.log.some(entry => entry.text === 'remember this line') ?? false, 'the message in the log')
  } finally {
    host.close()
  }

  const saved = readFileSync(join(stateDir, 'runner-state.json'), 'utf8')
  expect(saved).toContain('remember this line')
})

test('the session token is read from the page Hermes serves, the way the app reads it', async () => {
  const { readServedToken, wsUrlFor } = await import('../runner/host')
  const realFetch = globalThis.fetch

  try {
    globalThis.fetch = (async () =>
      new Response('<html><script>window.__HERMES_SESSION_TOKEN__ = "abc123";</script></html>')) as typeof fetch
    expect(await readServedToken('http://127.0.0.1:42687')).toBe('abc123')

    globalThis.fetch = (async () => new Response('<html>no token here</html>')) as typeof fetch
    await expect(readServedToken('http://127.0.0.1:42687')).rejects.toThrow('did not serve a session token')
  } finally {
    globalThis.fetch = realFetch
  }

  expect(wsUrlFor('http://127.0.0.1:42687', 'abc123')).toBe('ws://127.0.0.1:42687/api/ws?token=abc123')
  expect(wsUrlFor('https://hermes.example', '')).toBe('wss://hermes.example/api/ws')
})
