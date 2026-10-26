/**
 * What a bot works out loud in a group, and what the group keeps.
 *
 * Text a bot sends before a tool call is progress (Hermes sends it as an interim message). It goes
 * to the group's Work notes, not the chat. The answer is posted once, when the turn ends. A note
 * that names a teammate still wakes that teammate, and the teammate's prompt carries the note,
 * because the note is not in the group's log.
 *
 * Only the gateway transport is faked, as in rooms-wake.test.ts. rooms.ts, chat.ts and the sync
 * code are the production modules.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'

interface Call {
  method: string
  params: Record<string, any>
}

const calls: Call[] = []
let epoch = 0

const { gateway } = await import('../src/lib/gateway')

const PROFILE_ROWS = [
  { name: 'default', is_default: true, ui_meta: {} },
  { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha', lead: true } } },
  { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
]

gateway.request = (async (method: string, params: Record<string, any> = {}) => {
  calls.push({ method, params })

  if (method === 'profiles.list') return { profiles: PROFILE_ROWS }
  if (method === 'session.resume') return { session_id: `rt${++epoch}:${params.profile}`, messages: [], running: false, inflight: null }
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

const seedProfiles = () => {
  store.$profiles.set(JSON.parse(JSON.stringify(PROFILE_ROWS)))
  store.$userName.set('You')
}

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise(done => setTimeout(done, 0))
  }
}

const emit = (session: string, frame: any) => gateway.dispatch({ session_id: session, ...frame } as any)

/** The runtime a member's turn is running on: the session its last prompt was submitted to. */
const runtimeOf = (member: string) => String([...calls].reverse().find(call => call.method === 'prompt.submit' && call.params.profile === member)?.params.session_id || '')

/** Every prompt submitted to one member, in order. */
const promptsFor = (member: string) => calls.filter(call => call.method === 'prompt.submit' && call.params.profile === member).map(call => String(call.params.text || ''))

const newRoom = (members: string[]) => rooms.createRoom(`Work ${Math.random().toString(36).slice(2, 7)}`, members, { reply: 'everyone' })

const logOf = (key: string) => rooms.$rooms.get()[key].log.map(entry => entry.text)

const workOf = (roomId: string) => rooms.$roomWork.get().filter(item => item.roomId === roomId)

/** One piece of progress: text streamed, then ended by an interim event, as Hermes sends it before a tool call. */
const progress = (runtime: string, text: string) => {
  emit(runtime, { type: 'message.start', payload: {} })
  emit(runtime, { type: 'message.delta', payload: { text } })
  emit(runtime, { type: 'message.interim', payload: { already_streamed: true } })
}

beforeEach(() => {
  calls.length = 0
  seedProfiles()
})

afterEach(async () => {
  for (const room of Object.values(rooms.$rooms.get())) {
    await rooms.stopRoom(room.key)
    rooms.deleteRoom(room.key)
  }

  rooms.$rooms.set({})
  rooms.$roomWork.set([])
})

test('progress before a tool call stays in Work; the group gets the answer once, at the end', async () => {
  const room = newRoom(['alpha'])

  rooms.postToRoom(room.key, '@alpha go')
  await flush()

  const runtime = runtimeOf('alpha')

  progress(runtime, 'Checking the logs now.')
  await flush()

  expect(logOf(room.key)).toEqual(['@alpha go'])
  expect(workOf(room.roomId).map(item => [item.member, item.text])).toEqual([['alpha', 'Checking the logs now.']])

  emit(runtime, { type: 'message.delta', payload: { text: 'The fix is in.' } })
  emit(runtime, { type: 'message.complete', payload: { text: 'The fix is in.' } })
  await flush()

  expect(logOf(room.key)).toEqual(['@alpha go', 'The fix is in.'])
  expect(workOf(room.roomId)).toHaveLength(1)
})

test('a teammate named in progress is woken, and its prompt carries the note', async () => {
  const room = newRoom(['alpha', 'beta'])

  rooms.postToRoom(room.key, '@alpha look into it')
  await flush()

  progress(runtimeOf('alpha'), '@beta can you confirm the release tag?')
  await flush()

  // The note is progress: beta is not in the group log yet.
  expect(logOf(room.key)).toEqual(['@alpha look into it'])

  emit(runtimeOf('alpha'), { type: 'message.complete', payload: { text: 'Waiting on beta.' } })
  await flush(40)

  expect(logOf(room.key)).toEqual(['@alpha look into it', 'Waiting on beta.'])

  const betaPrompt = promptsFor('beta').at(-1) || ''

  expect(betaPrompt).toContain('Work from teammates that names you')
  expect(betaPrompt).toContain('@beta can you confirm the release tag?')
})

test('a long run keeps only the newest notes for each group', async () => {
  const room = newRoom(['alpha'])

  rooms.postToRoom(room.key, '@alpha keep going')
  await flush()

  const runtime = runtimeOf('alpha')

  for (let i = 0; i < 45; i++) {
    progress(runtime, `step ${i} done.`)
  }

  await flush()

  const mine = workOf(room.roomId)

  expect(mine).toHaveLength(40)
  expect(mine.at(0)?.text).toBe('step 5 done.')
  expect(mine.at(-1)?.text).toBe('step 44 done.')
})

test('notes sync up to the profile, and notes another device wrote come back in', async () => {
  const room = newRoom(['alpha'])

  rooms.postToRoom(room.key, '@alpha go')
  await flush()

  progress(runtimeOf('alpha'), 'Local note.')
  await flush()
  await rooms.saveWork()

  const sent = calls.filter(call => call.method === 'profiles.configure' && call.params.ui_meta?.['hermes-bots-work']).at(-1)

  expect(sent?.params.ui_meta['hermes-bots-work'].items.map((item: any) => item.text)).toContain('Local note.')

  // Another device wrote a note for the same group; the next sync takes it in and keeps ours.
  const rows = JSON.parse(JSON.stringify(PROFILE_ROWS))

  rows[0].ui_meta = { 'hermes-bots-work': { items: [{ id: 'remote-1', roomId: room.roomId, member: 'beta', at: Date.now(), text: 'Remote note.' }] } }
  store.$profiles.set(rows)
  rooms.loadRooms(true)

  expect(workOf(room.roomId).map(item => item.text).sort()).toEqual(['Local note.', 'Remote note.'])
})
