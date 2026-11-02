/**
 * Two writers share each synced key: this app and the VM runner. A write carries the revision its
 * content was read at, and Hermes refuses it when the key has moved on. A write that goes out at a
 * newer revision with older content silently drops whatever the other writer saved in between.
 *
 * Only the gateway transport is faked, and the fake compares revisions the way Hermes's
 * profiles.configure does. rooms.ts and the sync code are the production modules.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'

interface Call {
  method: string
  params: Record<string, any>
}

const calls: Call[] = []
let epoch = 0

const { gateway } = await import('../src/lib/gateway')

const SYNC = 'hermes-bots-groups'
const WORK = 'hermes-bots-work'
const LIVE = 'hermes-bots-live'
const ROOM_ID = 'room-sync'
const ROOM_KEY = `id:${ROOM_ID}`

/** What Hermes holds for the profiles: ui_meta and its per-key revisions. */
const server = { ui: {} as Record<string, any>, revisions: {} as Record<string, number> }

const rowsFromServer = () => [
  { name: 'default', is_default: true, ui_meta: structuredClone(server.ui), ui_meta_revisions: { ...server.revisions } },
  { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha', lead: true } }, ui_meta_revisions: {} },
  { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } }, ui_meta_revisions: {} }
]

/** Hermes's ui_meta write: with expected revisions, a key that moved on refuses the whole write. */
function configure(params: Record<string, any>) {
  const incoming: Record<string, any> = params.ui_meta || {}
  const keys = Object.keys(incoming)
  const expected = params.ui_meta_expected_revisions
  const conflicts: Record<string, unknown> = {}

  if (expected && typeof expected === 'object') {
    for (const key of keys) {
      const wanted = expected[key]
      const actual = server.revisions[key] || 0

      if (typeof wanted !== 'number' || wanted !== actual) {
        conflicts[key] = { expected: wanted, actual }
      }
    }
  }

  const revisions = Object.fromEntries(keys.map(key => [key, server.revisions[key] || 0]))

  if (Object.keys(conflicts).length) {
    return { applied: { ui_meta: false, ui_meta_conflicts: conflicts, ui_meta_revisions: revisions } }
  }

  for (const key of keys) {
    server.ui[key] = structuredClone(incoming[key])
    server.revisions[key] = (server.revisions[key] || 0) + 1
    revisions[key] = server.revisions[key]
  }

  return { applied: { ui_meta: true, ui_meta_revisions: revisions } }
}

gateway.request = (async (method: string, params: Record<string, any> = {}) => {
  calls.push({ method, params })

  if (method === 'profiles.list') return { profiles: rowsFromServer() }
  if (method === 'profiles.configure') return configure(params)
  if (method === 'session.resume') return { session_id: `rs${++epoch}:${params.profile}`, messages: [], running: false, inflight: null }
  if (method === 'session.steer') return { status: 'steered' }

  return {}
}) as typeof gateway.request

gateway.state.set('open')

// The app runs in an Electron renderer, so localStorage is always there; Bun has no such global.
const cache = new Map<string, string>()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => (cache.has(key) ? cache.get(key) : null),
    setItem: (key: string, value: string) => void cache.set(key, String(value)),
    removeItem: (key: string) => void cache.delete(key),
    clear: () => void cache.clear(),
    key: (index: number) => [...cache.keys()][index] ?? null,
    get length() {
      return cache.size
    }
  }
})

const hosts = await import('../src/lib/hosts')

hosts.$machines.set([])
hosts.$defaultHost.set('')

const store = await import('../src/lib/store')
const rooms = await import('../src/lib/rooms')

let clock = 1_000

const message = (id: string, text: string, from = 'You') => ({
  id,
  at: clock++,
  from: { kind: from === 'You' ? 'user' : 'member', name: from },
  text
})

/** Puts the room envelope on the server at a revision, and reads the default profile's row as the app would. */
function serveRooms(revision: number, log: ReturnType<typeof message>[], options: { settings?: Record<string, unknown>; members?: string[] } = {}) {
  server.ui[SYNC] = {
    version: 3,
    updatedAt: Date.now(),
    rooms: {
      [ROOM_KEY]: {
        name: 'Sync room',
        roomId: ROOM_ID,
        log,
        members: (options.members || []).map(name => ({ name, handle: name })),
        revision: 1,
        ...(options.settings ? { settings: options.settings } : {})
      }
    }
  }
  server.revisions[SYNC] = revision
  store.$profiles.set(rowsFromServer())
}

const serverLog = () => server.ui[SYNC].rooms[ROOM_KEY].log.map((entry: { text: string }) => entry.text)

const settle = (ms = 1500) => new Promise(done => setTimeout(done, ms))

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise(done => setTimeout(done, 0))
  }
}

const emit = (session: string, frame: any) => gateway.dispatch({ session_id: session, ...frame } as any)

/** The runtime a member's turn is running on: the session its last prompt was submitted to. */
const runtimeOf = (member: string) => String([...calls].reverse().find(call => call.method === 'prompt.submit' && call.params.profile === member)?.params.session_id || '')

beforeEach(() => {
  calls.length = 0
  server.ui = {}
  server.revisions = {}
  rooms.setConductor('app')
  rooms.$rooms.set({})
  rooms.$roomWork.set([])
  rooms.$roomTyping.set({})
  rooms.$runnerTyping.set({})
})

afterEach(async () => {
  for (const room of Object.values(rooms.$rooms.get())) {
    await rooms.stopRoom(room.key)
  }

  rooms.setConductor('app')
  rooms.$rooms.set({})
})

test('a write at a newer revision takes in the messages that revision holds before it sends', async () => {
  serveRooms(1, [message('m1', 'first')])
  rooms.loadRooms(true)

  // The runner saved revision 2 with its own note. This device's rooms were not reloaded from it.
  serveRooms(2, [message('m1', 'first'), message('r1', 'runner note', 'coding-manager-2')])
  rooms.postToRoom(ROOM_KEY, 'i seee')
  await settle()

  expect(serverLog()).toEqual(['first', 'runner note', 'i seee'])
})

test('a room deleted here stays deleted when a newer revision still lists it', async () => {
  serveRooms(1, [message('m1', 'first')])
  rooms.loadRooms(true)
  rooms.deleteRoom(ROOM_KEY)

  // Another writer saved the room again before this device's delete reached the server.
  serveRooms(2, [message('m1', 'first')])
  await settle()

  expect(server.ui[SYNC].rooms[ROOM_KEY]).toBeUndefined()
  expect(server.ui[SYNC].deleted?.[ROOM_KEY]).toBeDefined()
})

test('work notes behind a newer revision are taken in before the work write', async () => {
  const note = (id: string, text: string) => ({ id, roomId: ROOM_ID, member: 'scout', at: clock++, text })

  server.ui[WORK] = { version: 1, updatedAt: Date.now(), items: [note('w1', 'one')] }
  server.revisions[WORK] = 1
  store.$profiles.set(rowsFromServer())
  rooms.loadRooms(true)

  // The runner wrote revision 2 with another note.
  server.ui[WORK] = { version: 1, updatedAt: Date.now(), items: [note('w1', 'one'), note('w2', 'two')] }
  server.revisions[WORK] = 2
  store.$profiles.set(rowsFromServer())

  rooms.$roomWork.set([...rooms.$roomWork.get(), note('w3', 'three')])
  await rooms.saveWork()

  expect(server.ui[WORK].items.map((item: { id: string }) => item.id)).toEqual(['w1', 'w2', 'w3'])
})

test('a runner publishes who is working in its groups, and clears it when the turn ends', async () => {
  serveRooms(1, [], { settings: { runner: true }, members: ['alpha'] })
  rooms.setConductor('runner')
  rooms.loadRooms(true)

  rooms.postToRoom(ROOM_KEY, '@alpha go')
  await flush()

  const runtime = runtimeOf('alpha')
  emit(runtime, { type: 'message.start', payload: {} })
  await settle(600)

  expect(server.ui[LIVE].working[ROOM_ID]).toEqual(['alpha'])

  emit(runtime, { type: 'message.complete', payload: { text: 'Done.' } })
  await flush()
  await settle(600)

  expect(server.ui[LIVE].working[ROOM_ID]).toBeUndefined()
})

test('the app shows a turn its runner is running in a group it does not run', async () => {
  serveRooms(1, [], { settings: { runner: true }, members: ['alpha'] })
  rooms.loadRooms(true)

  server.ui[LIVE] = { version: 1, updatedAt: Date.now(), working: { [ROOM_ID]: ['alpha'] } }
  await rooms.refreshLive()

  expect(Object.keys(rooms.$typingAll.get()[ROOM_KEY] || {})).toEqual(['alpha'])
  // The app's own turn state is untouched, so its busy checks do not see the runner's turns.
  expect(rooms.$roomTyping.get()[ROOM_KEY]).toBeUndefined()

  server.ui[LIVE] = { version: 1, updatedAt: Date.now(), working: {} }
  await rooms.refreshLive()

  expect(rooms.$typingAll.get()[ROOM_KEY]).toBeUndefined()
})

test('a live key the runner has not refreshed for minutes shows no turns', async () => {
  serveRooms(1, [], { settings: { runner: true }, members: ['alpha'] })
  rooms.loadRooms(true)

  server.ui[LIVE] = { version: 1, updatedAt: Date.now() - 10 * 60_000, working: { [ROOM_ID]: ['alpha'] } }
  await rooms.refreshLive()

  expect(rooms.$typingAll.get()[ROOM_KEY]).toBeUndefined()
})
