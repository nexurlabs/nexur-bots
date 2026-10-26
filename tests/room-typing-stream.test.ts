/**
 * Verifies that simultaneous streams stay in distinct rendered bubbles while using the production
 * room scheduler, chat reducer, gateway dispatch path, and React room view. Only RPC transport is
 * stubbed; stream frames still enter through the real gateway dispatcher.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ── harness ────────────────────────────────────────────────────────────────
interface Call {
  method: string
  params: Record<string, any>
}

const calls: Call[] = []
const activeRuntimes = new Map<string, string>()

/** Frames go in through the real gateway's dispatch, the same entry point a socket frame takes.
 * Chat.ts registers its own listener on the real gateway, so there is nothing to capture here and
 * no listener fan-out to get wrong. */
const emit = (session: string, frame: any) => {
  gateway.dispatch({ session_id: session, ...frame } as any)

  if (frame.type === 'message.complete' || frame.type === 'error') {
    activeRuntimes.delete(session)
  }
}

// The real gateway module runs untouched. Only the singleton's transport methods are replaced, so
// the class, RpcError, routing and the event fan-out the app depends on stay production code — a
// module-level mock would hide a real difference between what ships and what is tested.
//
// A real gateway issues a NEW runtime id per resume, and chat.ts keys its session cache by
// room/member for the life of the module. Issuing a fresh id per resume is therefore both what
// production does and what keeps one test's session from leaking into the next.
let epoch = 0

const { gateway } = await import('../src/lib/gateway')
const originalGatewayRequest = Object.getOwnPropertyDescriptor(gateway, 'request')
const originalGatewayState = gateway.state.get()

gateway.request = (async (method: string, params: Record<string, any> = {}) => {
  calls.push({ method, params })

  if (method === 'prompt.submit') {
    activeRuntimes.set(String(params.session_id), String(params.profile))
  }

  // session.resume asks for a live runtime by profile; hand back a fresh one, as the gateway would.
  if (method === 'session.resume') {
    return { session_id: `rt${++epoch}:${params.profile}`, messages: [], running: false, inflight: null }
  }

  return {}
}) as typeof gateway.request

gateway.state.set('open')

// The app runs in an Electron renderer, so localStorage is always there; Bun has no such global.
const cache = new Map<string, string>()
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

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

const memory = await import('../src/lib/memory')
const noteTurnEndCalls: string[] = []
const expectedTurnEnds = new Set<string>()

// Room typing is under test; keep the unrelated delayed user-memory import from starting a timer.
await mock.module('../src/lib/memory', () => ({
  ...memory,
  noteTurnEnd: (name: string) => noteTurnEndCalls.push(name)
}))

// Text-only stream frames do not invoke the attachment/file path.

// Members live on machines. The real module runs; $machines is empty by default, which is the
// "everything is local and online" state the harness wants.
const hosts = await import('../src/lib/hosts')
const originalMachines = hosts.$machines.get()
const originalDefaultHost = hosts.$defaultHost.get()

hosts.$machines.set([])
hosts.$defaultHost.set('')

// The real team.ts runs too. rooms.ts only uses its source/registry helpers, and with the seeded
// profile rows they resolve against these bots without any stub.

// Seed the store's profile rows. $allBots, $userName and teamContext all derive from $profiles, so
// this one write is the only seam the room scheduler needs.
const store = await import('../src/lib/store')
const originalProfiles = store.$profiles.get()
const originalUserName = store.$userName.get()
const originalBusy = store.$busy.get()

store.$profiles.set([
  { name: 'default', is_default: true, ui_meta: {} },
  { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha', lead: true } } },
  { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } },
  { name: 'constructor', ui_meta: { 'hermes-bots': { title: 'Constructor' } } },
  { name: 'toString', ui_meta: { 'hermes-bots': { title: 'To String' } } },
  { name: '__proto__', ui_meta: { 'hermes-bots': { title: 'Proto' } } }
] as any)

store.$userName.set('You')

const rooms = await import('../src/lib/rooms')
const { RoomView } = await import('../src/ui/views')
const originalRooms = rooms.$rooms.get()
const originalTyping = rooms.$roomTyping.get()
const originalRunning = rooms.$roomRunning.get()

// ── fixtures ───────────────────────────────────────────────────────────────
const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise(done => setTimeout(done, 0))
  }
}

const runtimeOf = (roomId: string, member: string) => {
  const submitted_for = [...calls].reverse().find(call => call.method === 'prompt.submit' && call.params.profile === member)

  return String(submitted_for?.params.session_id || `rt:${roomId}:${member}`)
}

/** Opens a bubble the way the gateway does, then streams into it without ever ending it. */
const stream = (roomId: string, member: string, text: string) => {
  const runtime = runtimeOf(roomId, member)
  emit(runtime, { type: 'message.start', payload: {} })
  emit(runtime, { type: 'message.delta', payload: { text } })
}

const complete = async (roomId: string, member: string, text: string) => {
  const runtime = runtimeOf(roomId, member)

  expectedTurnEnds.add(member)
  emit(runtime, { type: 'message.complete', payload: { text } })
  await flush()
}

const typing = (key: string) => (rooms as any).$roomTyping.get()[key] || {}

let roomN = 0
const createdRoomKeys = new Set<string>()
const newRoom = (members: string[], settings?: any) => {
  const room = rooms.createRoom(`Typing ${roomN++}`, members, settings)

  createdRoomKeys.add(room.key)
  return room
}

afterEach(async () => {
  // Let any scheduled member turns reach prompt.submit before inspecting active runtimes.
  await flush(24)

  for (const key of createdRoomKeys) {
    await rooms.stopRoom(key)
  }

  // The RPC mock does not emit an interrupt frame, so end each tracked production listener explicitly.
  for (const [runtime, member] of activeRuntimes) {
    expectedTurnEnds.add(member)
    emit(runtime, { type: 'message.complete', payload: { text: '' } })
  }

  await flush(24)
  expect(activeRuntimes.size).toBe(0)

  for (const key of createdRoomKeys) {
    expect(rooms.$roomTyping.get()[key] || {}).toEqual({})
  }

  const remainingRooms = { ...rooms.$rooms.get() }
  const remainingRunning = { ...rooms.$roomRunning.get() }

  for (const key of createdRoomKeys) {
    delete remainingRooms[key]
    delete remainingRunning[key]
  }

  rooms.$rooms.set(remainingRooms)
  rooms.$roomRunning.set(remainingRunning)
  createdRoomKeys.clear()
  expect(rooms.$roomRunning.get()).toEqual(originalRunning)
  for (const member of expectedTurnEnds) {
    expect(noteTurnEndCalls).toContain(member)
  }

  store.$busy.set(originalBusy)
  calls.length = 0
  noteTurnEndCalls.length = 0
  expectedTurnEnds.clear()
  cache.clear()
})

afterAll(async () => {
  // createRoom/postToRoom debounce a profile sync for 1.2s; let it run against the stub before restoring the live gateway.
  await new Promise(resolve => setTimeout(resolve, 1300))

  if (originalGatewayRequest) {
    Object.defineProperty(gateway, 'request', originalGatewayRequest)
  } else {
    Reflect.deleteProperty(gateway, 'request')
  }

  gateway.state.set(originalGatewayState)
  hosts.$machines.set(originalMachines)
  hosts.$defaultHost.set(originalDefaultHost)
  store.$profiles.set(originalProfiles)
  store.$userName.set(originalUserName)
  store.$busy.set(originalBusy)
  rooms.$rooms.set(originalRooms)
  rooms.$roomTyping.set(originalTyping)
  rooms.$roomRunning.set(originalRunning)

  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage')
  }

  mock.restore()
})

// ── concurrent stream rendering ────────────────────────────────────────────
describe('per-member typing renders every live stream', () => {
  test('two streaming members get separate bubbles and one completion leaves the other live', async () => {
    const room = newRoom(['alpha', 'beta'], { reply: 'everyone' })

    // Direct wakes run one at a time; a second user message is what puts two members on at once.
    rooms.postToRoom(room.key, '@alpha answer')
    await flush()

    stream(room.roomId, 'alpha', 'alpha writing something long')
    await flush()

    rooms.postToRoom(room.key, '@beta answer too')
    await flush()
    stream(room.roomId, 'beta', 'beta writing at the same time')
    await flush()

    let live = typing(room.key)

    expect(Object.keys(live).sort()).toEqual(['alpha', 'beta'])
    expect(live.alpha.messages.map((message: any) => message.text).join('')).toContain('alpha writing')
    expect(live.beta.messages.map((message: any) => message.text).join('')).toContain('beta writing')
    expect(Boolean(store.$busy.get().constructor)).toBe(false)
    expect(Boolean(store.$busy.get().toString)).toBe(false)

    const getHtml = () => renderToStaticMarkup(createElement(RoomView, { room: rooms.$rooms.get()[room.key] }))
    let html = getHtml()

    // Each working bot shows as a typing bubble. What it is writing stays out of the chat until its answer.
    expect((html.match(/class="bubble typing"/g) || []).length).toBe(2)
    expect(html).not.toContain('alpha writing something long')
    expect(html).not.toContain('beta writing at the same time')

    await complete(room.roomId, 'alpha', 'alpha finished')
    live = typing(room.key)
    html = getHtml()

    expect(Object.keys(live)).toEqual(['beta'])
    expect((html.match(/class="bubble typing"/g) || []).length).toBe(1)
    // Alpha's answer is posted to the chat; beta's text is still only in its typing bubble.
    expect(html).toContain('alpha writing something long')
    expect(html).not.toContain('beta writing at the same time')

    expect(rooms.roomInTurn('constructor')).toBeNull()
    expect(rooms.roomInTurn('toString')).toBeNull()
    expect(rooms.isMemberTypingInRoom('constructor')).toBe(false)

    const constructorRoom = newRoom(['constructor'])
    const post = rooms.postFromBot('constructor', constructorRoom.name, 'an idle bot can post')

    expect(post.ok).toBe(true)
  })

  test('a profile named __proto__ remains an enumerable live member', async () => {
    const room = newRoom(['__proto__'], { reply: 'everyone' })

    rooms.postToRoom(room.key, '@everyone start')
    await flush()

    stream(room.roomId, '__proto__', 'proto-named bot is typing')
    await flush()

    const live = typing(room.key)
    const html = renderToStaticMarkup(createElement(RoomView, { room: rooms.$rooms.get()[room.key] }))

    expect(Object.keys(live)).toEqual(['__proto__'])
    expect(live['__proto__'].messages.map((message: any) => message.text).join('')).toContain('proto-named bot is typing')
    expect(Object.prototype.hasOwnProperty.call(store.$busy.get(), '__proto__')).toBe(true)
    expect(store.$busy.get()['__proto__']).toBe(true)
    expect((html.match(/class="bubble typing"/g) || []).length).toBe(1)
    expect(html).not.toContain('proto-named bot is typing')
  })
})
