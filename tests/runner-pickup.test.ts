/**
 * Who answers a group, when the app and the VM runner are both running.
 *
 * A group the runner owns (settings.runner) is answered only by the runner: the app posts the user's
 * message and stays silent, and the runner picks the message up on its next pass. A group the app
 * owns is left alone by the runner. Only the gateway transport is faked, as in runner-host.test.ts.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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

const settle = () => new Promise(resolve => setTimeout(resolve, 60))

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
  stateDir = mkdtempSync(join(tmpdir(), 'runner-pickup-'))
  calls.length = 0
})

afterEach(async () => {
  const rooms = await import('../src/lib/rooms')
  const store = await import('../src/lib/store')

  for (const room of Object.values(rooms.$rooms.get())) {
    await rooms.stopRoom(room.key)
    rooms.deleteRoom(room.key)
  }

  rooms.$rooms.set({})
  rooms.setConductor('app')

  for (const name of Object.keys(store.$busy.get())) {
    for (const scope of ['dm', 'group', 'external'] as const) {
      store.releaseBusy(name, scope)
    }
  }

  rmSync(stateDir, { recursive: true, force: true })
})

test('a message the app posts in a runner group is answered by the runner, not the app', async () => {
  const { startHost } = await import('../runner/host')
  const { pickUpNewMessages } = await import('../runner/pickup')
  const rooms = await import('../src/lib/rooms')
  const host = await startHost({ hermesUrl: 'http://runner-test', stateDir, readToken: async () => 'test-token' })

  try {
    const room = rooms.createRoom('Runner owned', ['alpha'], { reply: 'everyone', runner: true })

    // The app posts the message; the app's conductor must not answer a group the runner owns.
    rooms.setConductor('app')
    rooms.postToRoom(room.key, '@alpha hello from the app')
    await settle()
    expect(submittedTo('alpha')).toHaveLength(0)

    // The runner's next pass picks the message up and answers it.
    rooms.setConductor('runner')
    await pickUpNewMessages()
    await waitFor(() => submittedTo('alpha').length === 1, 'the runner to answer the app message')
  } finally {
    host.close()
  }
})

test('a message is picked up once, not again on the next pass', async () => {
  const { startHost } = await import('../runner/host')
  const { pickUpNewMessages } = await import('../runner/pickup')
  const rooms = await import('../src/lib/rooms')
  const host = await startHost({ hermesUrl: 'http://runner-test', stateDir, readToken: async () => 'test-token' })

  try {
    const room = rooms.createRoom('Picked once', ['alpha'], { reply: 'everyone', runner: true })
    rooms.setConductor('app')
    rooms.postToRoom(room.key, '@alpha only once')
    rooms.setConductor('runner')

    await pickUpNewMessages()
    await waitFor(() => submittedTo('alpha').length === 1, 'the first pickup')

    await pickUpNewMessages()
    await settle()
    expect(submittedTo('alpha')).toHaveLength(1)
  } finally {
    host.close()
  }
})

test('the runner leaves a group the app owns alone', async () => {
  const { startHost } = await import('../runner/host')
  const { pickUpNewMessages } = await import('../runner/pickup')
  const rooms = await import('../src/lib/rooms')
  const host = await startHost({ hermesUrl: 'http://runner-test', stateDir, readToken: async () => 'test-token' })

  try {
    const room = rooms.createRoom('App owned', ['alpha'], { reply: 'everyone' })

    // In the runner's process this group is the app's: a post here must not start a turn.
    rooms.setConductor('runner')
    rooms.postToRoom(room.key, '@alpha the app answers this group')

    await pickUpNewMessages()
    await settle()
    expect(submittedTo('alpha')).toHaveLength(0)
  } finally {
    host.close()
  }
})
