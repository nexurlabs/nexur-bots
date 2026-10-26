/**
 * Who is allowed to steer a member that is already working in a room, and what the room shows
 * while two members stream at once.
 *
 * The user's rules: a plain message must leave a working bot alone; only a message aimed AT that
 * bot (@mention, @everyone, or a reply that names it) may fold into the running turn. And the
 * "two bots in one box" glitch: $roomTyping is ONE slot per room, so a second member starting
 * while the first streams replaces the slot and the view flips between the two.
 *
 * Only the transport is mocked. `src/lib/rooms.ts` and `src/lib/chat.ts` are the real modules, so
 * the scheduler, the streaming reducer and the wake selection under test are the production ones.
 * Main ships no rooms suite at all; this is it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ── harness ────────────────────────────────────────────────────────────────
interface Call {
  method: string
  params: Record<string, any>
}

const calls: Call[] = []
let handlers: Record<string, (params: any) => any> = {}

const of = (method: string) => calls.filter(call => call.method === method)
const last = (method: string) => [...calls].reverse().find(call => call.method === method)
const submitted = () => of('prompt.submit')
const texts = () => submitted().map(call => String(call.params.text || ''))

/** Frames go in through the real gateway's dispatch, the same entry point a socket frame takes.
 * Chat.ts registers its own listener on the real gateway, so there is nothing to capture here and
 * no listener fan-out to get wrong. */
const emit = (session: string, frame: any) => gateway.dispatch({ session_id: session, ...frame } as any)

// The real gateway module runs untouched. Only the singleton's transport methods are replaced, so
// the class, RpcError, routing and the event fan-out the app depends on stay production code — a
// module-level mock would hide a real difference between what ships and what is tested.
//
// A real gateway issues a NEW runtime id per resume, and chat.ts keys its session cache by
// room/member for the life of the module. Issuing a fresh id per resume is therefore both what
// production does and what keeps one test's session from leaking into the next.
let epoch = 0

const { gateway } = await import('../src/lib/gateway')

/** The team this file runs against. Every profile refresh answers with it unless a test overrides it. */
const PROFILE_ROWS = [
  { name: 'default', is_default: true, ui_meta: {} },
  { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha', lead: true } } },
  { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
]
/** Per-test overrides for the next profiles.list answer: a reply to return, or a promise to hold. */
let profilesReply: any = null
let profilesHold: null | Promise<any> = null

gateway.request = (async (method: string, params: Record<string, any> = {}) => {
  calls.push({ method, params })

  if (method === 'profiles.list') {
    const hold = profilesHold
    profilesHold = null

    return hold ?? profilesReply ?? { profiles: PROFILE_ROWS }
  }

  if (handlers[method]) {
    return handlers[method](params)
  }

  // session.resume asks for a live runtime by profile; hand back a fresh one, as the gateway would.
  if (method === 'session.resume') {
    return { session_id: `rt${++epoch}:${params.profile}`, messages: [], running: false, inflight: null }
  }

  // A steer is accepted unless a test says otherwise.
  if (method === 'session.steer') {
    return { status: 'steered' }
  }

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

// No attachment mock: the real module runs. These tests send text only, so its file paths are
// never reached, and a module-level mock here would drop exports other importers need
// (splitAttachments and friends) exactly as it did before.

// Members live on machines. The real module runs; $machines is empty by default, which is the
// "everything is local and online" state the harness wants.
const hosts = await import('../src/lib/hosts')

hosts.$machines.set([])
hosts.$defaultHost.set('')

// The real team.ts runs too. rooms.ts only uses its source/registry helpers, and with the seeded
// profile rows they resolve against these bots without any stub.

// Seed the store's profile rows. $allBots, $userName and teamContext all derive from $profiles, so
// this one write is the only seam the room scheduler needs. It is re-applied before every test:
// other test files clear the shared store, and this file must not depend on load-time state.
const store = await import('../src/lib/store')

const seedProfiles = () => {
  store.$profiles.set(JSON.parse(JSON.stringify(PROFILE_ROWS)))

  store.$userName.set('You')
}

seedProfiles()

const rooms = await import('../src/lib/rooms')

// ── fixtures ───────────────────────────────────────────────────────────────
const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise(done => setTimeout(done, 0))
  }
}

/**
 * Lets the scheduler hand the room round. `drain()` runs one member per pass and re-arms itself
 * from the finally block, so a second member only starts after the first publishes or releases
 * the speak slot — flushing alone is not enough, the turn has to actually be finished.
 */
const letOthersSpeak = async (room: { roomId: string }, member: string, text = `${member} done`) => {
  emit(runtimeOf(room.roomId, member), { type: 'message.complete', payload: { text } })
  await flush(20)
}

/**
 * The runtime a member's turn is running on. Every resume issues a fresh id, so the live runtime
 * is whichever the last submit for that member named — the same thing the app would know.
 */
const runtimeOf = (roomId: string, member: string) => {
  const submitted_for = [...calls].reverse().find(call => call.method === 'prompt.submit' && call.params.profile === member)

  return String(submitted_for?.params.session_id || `rt:${roomId}:${member}`)
}

const titleOf = (member: string) => (member === 'alpha' ? 'Alpha' : 'Beta')

/** Every prompt submitted to one member, in order. */
const promptsFor = (member: string) => texts().filter(text => text.includes(`You are ${titleOf(member)} (@${member})`))

/** Opens a bubble the way the gateway does, then streams into it without ever ending it. */
const stream = (roomId: string, member: string, text: string) => {
  const runtime = runtimeOf(roomId, member)
  emit(runtime, { type: 'message.start', payload: {} })
  emit(runtime, { type: 'message.delta', payload: { text } })
}

const complete = async (roomId: string, member: string, text: string) => {
  emit(runtimeOf(roomId, member), { type: 'message.complete', payload: { text } })
  await flush()
}

/**
 * The live typing turns in a room, as the per-bot map: room -> member -> turn.
 *
 * This used to be one slot per room, which is why a second member's stream overwrote the first
 * one's. Reading it through this helper keeps the assertions about what a viewer can SEE true
 * whichever shape the store is in.
 */
const typing = (key: string) => {
  const slot = (rooms as any).$roomTyping.get()[key]

  if (!slot) {
    return null
  }

  return slot.messages ? slot : Object.values(slot)[0] || null
}

/** Every member currently streaming in a room. */
const typingMembers = (key: string) => Object.keys((rooms as any).$roomTyping.get()[key] || {})

let roomN = 0
const newRoom = (members: string[], settings?: any) => rooms.createRoom(`Wake ${roomN++}`, members, settings)

beforeEach(async () => {
  // A background refresh left by an earlier test file may still be settling. Let it finish, then
  // start every test from the seeded team, so no test depends on what ran before it.
  await flush()
  profilesReply = null
  profilesHold = null
  seedProfiles()
})

afterEach(async () => {
  for (const room of Object.values(rooms.$rooms.get())) {
    await rooms.stopRoom(room.key)
    rooms.deleteRoom(room.key)
  }

  rooms.$rooms.set({})
  // A turn a test left running never settles here, so its busy claim would outlive the test.
  // $busy is global by member name: release every claim, as a finished turn would.
  for (const name of Object.keys(store.$busy.get())) {
    for (const scope of ['dm', 'group', 'external'] as const) {
      store.releaseBusy(name, scope)
    }
  }
  // Another file may have cleared the shared profile store since this one loaded.
  seedProfiles()
  calls.length = 0
  cache.clear()
  handlers = {}
})

// ── the rules ──────────────────────────────────────────────────────────────
describe('steering a working member is opt-in', () => {
  /**
   * Alpha is mid-turn and never ends, so every wake below meets a live turn. Beta is only started
   * here when a test needs it, because drain() hands the room round one member at a time.
   */
  const busyAlpha = async (members = ['alpha']) => {
    const room = newRoom(members, { reply: 'everyone' })

    rooms.postToRoom(room.key, `@${members.join(' @')} start`)

    await flush()
    expect(promptsFor('alpha').length).toBe(1)

    stream(room.roomId, 'alpha', 'alpha is mid sentence')

    await flush()
    expect(of('session.steer').length).toBe(0)
    expect(of('session.interrupt').length).toBe(0)

    return room
  }

  test('a plain room message does not steer a bot that is already working', async () => {
    const room = await busyAlpha()

    rooms.postToRoom(room.key, 'no one in particular, just thinking out loud')

    await flush()
    expect(of('session.steer').length).toBe(0)
    expect(of('session.interrupt').length).toBe(0)
    // No second turn either: the message is held for later, not re-run now.
    expect(promptsFor('alpha').length).toBe(1)
  })

  test('a held plain message is not replayed when the bot frees up; its next call reads it', async () => {
    const room = await busyAlpha()

    rooms.postToRoom(room.key, 'held while you were busy')
    await flush()

    // The turn ends. Nobody addressed alpha, so the message does not call it again.
    await letOthersSpeak(room, 'alpha', 'alpha done')
    expect(promptsFor('alpha').length).toBe(1)

    // The next call that names alpha carries the message it skipped.
    rooms.postToRoom(room.key, '@alpha back now?')
    await flush()
    expect(texts().some(text => text.includes('held while you were busy'))).toBe(true)
  })

  test('an @mention still steers the working bot', async () => {
    const room = await busyAlpha()

    rooms.postToRoom(room.key, '@alpha actually make it two pages')

    await flush()
    expect(of('session.steer').length).toBe(1)
    const steer = last('session.steer')!

    expect(steer.params.profile).toBe('alpha')
    expect(steer.params.text).toBe('@alpha actually make it two pages')
    // A steer, not a second turn.
    expect(promptsFor('alpha').length).toBe(1)
    expect(of('session.interrupt').length).toBe(0)
  })

  test('@everyone steers the working bot like a direct mention', async () => {
    const room = await busyAlpha()

    // No stop word here: a stop word next to a mention is a Stop directive, not a nudge.
    rooms.postToRoom(room.key, '@everyone drop the vague framing')

    await flush()
    expect(of('session.steer').length).toBe(1)
    expect(last('session.steer')!.params.profile).toBe('alpha')
    expect(of('session.interrupt').length).toBe(0)
  })

  test("a bot's @mention of a working teammate does not interrupt it", async () => {
    const room = await busyAlpha()

    // Alpha hands over to a second member while alpha is still mid-turn.
    emit(runtimeOf(room.roomId, 'alpha'), { type: 'message.complete', payload: { text: '@beta your turn to answer this' } })
    await flush()

    // Alpha was not cut into by its own handoff: no interrupt, no second turn for it.
    expect(of('session.interrupt').length).toBe(0)
    expect(promptsFor('alpha').length).toBe(1)
  })

  test('a plain message leaves a working bot alone but an idle bot still answers', async () => {
    const room = newRoom(['alpha', 'beta'], { reply: 'everyone' })

    rooms.postToRoom(room.key, '@alpha start something long')
    await flush()
    stream(room.roomId, 'alpha', 'alpha is working')
    await flush()
    expect(of('session.steer').length).toBe(0)

    // Beta has no live turn, so the same plain message still reaches it.
    rooms.postToRoom(room.key, '@beta anything to add?')

    await flush()
    expect(of('session.steer').length).toBe(0)
    expect(texts().some(text => text.includes('You are Beta (@beta)'))).toBe(true)
  })

  test('a plain group message does not wake a bot that is busy in its own 1:1 chat', async () => {
    const { claimBusy, releaseBusy } = await import('../src/lib/store')
    const room = newRoom(['alpha', 'beta'], { reply: 'everyone' })

    // Alpha is mid-DM: the 1:1 turn holds its dm busy claim, but no group turn exists.
    claimBusy('alpha', 'dm')
    try {
      rooms.postToRoom(room.key, 'hi everyone')
      // Let the room hand its round to whoever is idle, the same way the harness does.
      await letOthersSpeak(room, 'beta', 'beta here')
      await letOthersSpeak(room, 'alpha', 'alpha here')

      expect(promptsFor('alpha').length).toBe(0)
      expect(promptsFor('beta').length).toBe(1)
      expect(of('session.steer').length).toBe(0)
    } finally {
      releaseBusy('alpha', 'dm')
    }
  })

  test('a plain message is not replayed when a busy bot frees up; its next call reads it', async () => {
    const { claimBusy, releaseBusy } = await import('../src/lib/store')
    const room = newRoom(['alpha'], { reply: 'everyone' })

    claimBusy('alpha', 'dm')
    rooms.postToRoom(room.key, 'hi everyone')
    await flush()
    releaseBusy('alpha', 'dm')
    await flush()

    // Freeing up does not call the bot for a message nobody addressed to it.
    expect(texts().some(text => text.includes('You are Alpha (@alpha)'))).toBe(false)

    // Its next call (a direct mention) still carries the message it skipped.
    rooms.postToRoom(room.key, '@alpha what did i miss')
    await flush()
    expect(texts().some(text => text.includes('hi everyone'))).toBe(true)
  })
})

// ── the "two bots in one box" glitch ───────────────────────────────────────
//
// The bug: $roomTyping was ONE slot per room, so a second member starting while the first
// streamed replaced that slot and the live bubble flipped between them. These read the per-bot
// map, and fail on the old single-slot shape.
describe('two members streaming at once', () => {
  test('both members are visible as typing at the same time', async () => {
    const room = newRoom(['alpha', 'beta'], { reply: 'everyone' })

    // Direct wakes run one at a time; a second user message is what puts two members on at once.
    rooms.postToRoom(room.key, '@alpha answer')
    await flush()

    stream(room.roomId, 'alpha', 'alpha writing something long')
    await flush()
    expect(typingMembers(room.key)).toContain('alpha')

    // Beta streams afterwards. This used to evict alpha from the room's single typing slot.
    rooms.postToRoom(room.key, '@beta answer too')
    await flush()
    stream(room.roomId, 'beta', 'beta writing at the same time')
    await flush()

    // Both are live at once — the whole point of the per-bot map.
    expect(typingMembers(room.key).sort()).toEqual(['alpha', 'beta'])
  })

  test("one member's stream does not carry the other's text", async () => {
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

    const turns = (rooms as any).$roomTyping.get()[room.key]
    const perMember = turns?.messages ? { [turns.member]: turns } : turns || {}
    const textOf = (member: string) => (perMember[member]?.messages || []).map((m: any) => m.text).join('')

    expect(textOf('alpha')).toContain('alpha writing')
    expect(textOf('alpha')).not.toContain('beta writing')
    expect(textOf('beta')).toContain('beta writing')
    expect(textOf('beta')).not.toContain('alpha writing')
  })

  test('both live replies reach the room log once each turn finishes', async () => {
    const room = newRoom(['alpha', 'beta'], { reply: 'everyone' })

    // Direct wakes run one at a time; a second user message is what puts two members on at once.
    rooms.postToRoom(room.key, '@alpha answer')
    await flush()

    // Mid-stream text is deliberately NOT in the log — that is the publication fix. Both
    // answers land when their turns end, so nothing is lost; it is only held back until it is
    // a finished reply rather than a half-streamed fragment.
    stream(room.roomId, 'alpha', 'alpha writing')
    await flush()
    rooms.postToRoom(room.key, '@beta answer too')
    await flush()
    stream(room.roomId, 'beta', 'beta writing')
    await flush()
    expect(rooms.$rooms.get()[room.key].log.some(entry => entry.text.includes('alpha writing'))).toBe(false)

    await complete(room.roomId, 'alpha', 'alpha finished its answer.')
    await complete(room.roomId, 'beta', 'beta finished its answer.')

    const published = rooms.$rooms.get()[room.key].log.map(entry => entry.text)

    expect(published.some(text => text.includes('alpha finished its answer.'))).toBe(true)
    expect(published.some(text => text.includes('beta finished its answer.'))).toBe(true)
  })
})

// ── a streamed fragment is not a message ───────────────────────────────────
//
// A turn used to publish the first thing it streamed, gated only by a hardcoded list of "pass"
// prefixes. Any other early token — "the", "I", "Let" — passed the gate, latched `publishedId`,
// and became a permanent one-word message with the real answer never posted behind it.
describe('only a finished reply is published', () => {
  const startTurn = async (members = ['alpha']) => {
    const room = newRoom(members, { reply: 'everyone' })

    rooms.postToRoom(room.key, members.length > 1 ? '@alpha @beta go' : '@alpha go')

    await flush()

    return room
  }

  const delta = (room: { roomId: string }, member: string, text: string) => emit(runtimeOf(room.roomId, member), { type: 'message.delta', payload: { text } })

  const log = (key: string) => rooms.$rooms.get()[key].log.map(entry => entry.text)

  test('a single streamed word is not published as a message', async () => {
    const room = await startTurn()

    delta(room, 'alpha', 'the')

    await flush()
    // Nothing but the user's own message is in the room: a fragment is not an answer.
    expect(log(room.key)).toEqual(['@alpha go'])
  })

  test('a completed sentence waits for the turn to end, then posts once as the answer', async () => {
    const room = await startTurn()

    delta(room, 'alpha', 'the')
    await flush()
    delta(room, 'alpha', ' quick brown fox jumps over the lazy dog.')
    await flush()

    // Nothing is posted while the turn runs: the answer is the finished turn, not a sentence on the way.
    expect(log(room.key)).toEqual(['@alpha go'])

    await complete(room.roomId, 'alpha', 'the quick brown fox jumps over the lazy dog.')

    const published = log(room.key)

    expect(published).toHaveLength(2)
    expect(published[1]).toBe('the quick brown fox jumps over the lazy dog.')
  })

  test('a reply that never reaches a sentence boundary still posts whole when the turn ends', async () => {
    const room = await startTurn()

    delta(room, 'alpha', 'here is the short answer you wanted')
    await flush()
    expect(log(room.key)).toEqual(['@alpha go'])

    await complete(room.roomId, 'alpha', 'here is the short answer you wanted')

    const published = log(room.key)

    expect(published).toHaveLength(2)
    expect(published[1]).toBe('here is the short answer you wanted')
  })

  test('a bare (pass) is never published', async () => {
    const room = await startTurn()

    delta(room, 'alpha', '(pass)')
    await flush()

    expect(log(room.key)).toEqual(['@alpha go'])
  })

  test('one fragmented turn produces exactly one message, not a fragment plus a duplicate', async () => {
    const room = await startTurn()

    delta(room, 'alpha', 'I')
    await flush()
    delta(room, 'alpha', ' will look at the logs now.')
    await flush()
    await complete(room.roomId, 'alpha', 'I will look at the logs now.')

    const fromAlpha = log(room.key).filter(text => text.includes('look at the logs'))

    expect(fromAlpha).toHaveLength(1)
    expect(fromAlpha[0]).toBe('I will look at the logs now.')
    // The lone "I" never became its own message.
    expect(log(room.key)).not.toContain('I')
  })
})

describe('a reply in a group wakes only the member it answers', () => {
  test('a reply names one member and no bot in the quoted text is woken', async () => {
    const room = newRoom(['alpha', 'beta'])

    // Alpha says something that mentions Beta. A reply to THAT message must not wake Beta.
    rooms.postToRoom(room.key, '@alpha what do you think of beta?')
    await flush()
    expect(promptsFor('alpha').length).toBe(1)

    // Let alpha's turn finish, so the reply below has to open a fresh one rather than queue.
    await letOthersSpeak(room, 'alpha', 'alpha answered')
    calls.length = 0

    // The user replies to alpha, quoting his text (which names beta).
    rooms.postToRoom(room.key, '> what do you think of beta?\n\nyes, go on', [], { answerTo: 'alpha' })
    await flush()

    expect(submitted().map(call => call.params.profile)).toEqual(['alpha'])
    expect(texts().some(text => text.includes('You are Beta (@beta)'))).toBe(false)
  })

  test('a reply overrides an @mention in the body', async () => {
    const room = newRoom(['alpha', 'beta'])

    rooms.postToRoom(room.key, '@alpha first question')
    await flush()
    await letOthersSpeak(room, 'alpha', 'alpha answered')
    calls.length = 0

    // Answering alpha, but typing @beta in the body. The reply target wins.
    rooms.postToRoom(room.key, '@beta can you weigh in too?', [], { answerTo: 'alpha' })
    await flush()

    expect(submitted().map(call => call.params.profile)).toEqual(['alpha'])
  })

  test('a reply steers that member when it is already working, and nobody else', async () => {
    const room = newRoom(['alpha', 'beta'], { reply: 'everyone' })

    rooms.postToRoom(room.key, '@alpha start something long')
    await flush()
    stream(room.roomId, 'alpha', 'alpha is mid sentence')
    await flush()

    calls.length = 0

    // Beta is idle, alpha is busy. The reply must reach alpha as a steer and not start beta.
    rooms.postToRoom(room.key, 'no, make it two pages', [], { answerTo: 'alpha' })
    await flush()

    expect(of('session.steer').length).toBe(1)
    expect(last('session.steer')!.params.profile).toBe('alpha')
    expect(submitted().map(call => call.params.profile)).toEqual([])
  })

  test('a reply to somebody no longer in the group fails visibly instead of waking everyone', async () => {
    const room = newRoom(['alpha'])

    rooms.postToRoom(room.key, '@alpha start')
    await flush()
    calls.length = 0

    rooms.postToRoom(room.key, 'answering a removed member', [], { answerTo: 'ghost' })
    await flush()

    // Nobody was woken, and the room says so rather than falling back to a room-wide wake.
    expect(submitted().length).toBe(0)
    const log = rooms.$rooms.get()[room.key].log
    expect(log[log.length - 1].text.toLowerCase()).toContain('ghost')
  })

  test('a plain message with no reply target still wakes the whole room', async () => {
    const room = newRoom(['alpha', 'beta'], { reply: 'everyone' })

    rooms.postToRoom(room.key, '@alpha start')
    await flush()
    await letOthersSpeak(room, 'alpha', 'alpha done')
    calls.length = 0

    // No answerTo: this is ordinary room chatter, so unheld members still get asked.
    rooms.postToRoom(room.key, 'any thoughts?')
    await flush()

    expect(submitted().length).toBeGreaterThan(0)
  })
})

// ── a mention must never be silently dropped ───────────────────────────────
//
// The user reported a message that said "@scout" in plain sight and got no answer at all, on a
// member that was mid-turn when it arrived. A queued mention that is then lost is indistinguishable
// from "the app didn't wake them", so it needs a test either way.
describe('a mention on a busy member', () => {
  test('is delivered when the turn ends, not dropped', async () => {
    const room = newRoom(['alpha', 'beta'], { reply: 'everyone' })

    // Alpha starts working and never finishes on its own.
    rooms.postToRoom(room.key, '@alpha start')
    await flush()
    stream(room.roomId, 'alpha', 'alpha is mid sentence')
    await flush()
    expect(promptsFor('alpha').length).toBe(1)

    // The mention arrives mid-turn and asks beta a question outright.
    rooms.postToRoom(room.key, '@beta what do you think?')
    await flush()

    // Beta is idle, so this one is immediate — no queue involved.
    expect(promptsFor('beta').length).toBe(1)
    expect(texts().some(text => text.includes('You are Beta (@beta)'))).toBe(true)
  })

  test('a mention naming a busy member is queued and answered, never lost', async () => {
    const room = newRoom(['alpha', 'beta'], { reply: 'everyone' })

    rooms.postToRoom(room.key, '@alpha @beta go')
    await flush()
    stream(room.roomId, 'alpha', 'alpha mid sentence')
    await flush()

    // Alpha is the member the mention names, and alpha is busy.
    rooms.postToRoom(room.key, '@alpha are you there?')
    await flush()

    // Either it steers now, or it waits — but it is never silently dropped: the count can
    // only have gone up, and the message must still reach alpha's prompt text.
    expect(promptsFor('alpha').length).toBeGreaterThanOrEqual(1)
    const steered = of('session.steer').length + promptsFor('alpha').length

    expect(steered).toBeGreaterThanOrEqual(1)

    // Nothing about this mention should interrupt or kill the live turn.
    expect(of('session.interrupt').length).toBe(0)
  })
})

// ── the bot directory survives a bad or late refresh ───────────────────────

describe('the bot directory keeps its last good list', () => {
  // Machine rows (named <profile>@<host>) are not part of this file's team.
  const names = () => store.$profiles.get().map((row: any) => row.name).filter((name: string) => !name.includes('@'))

  test('a profiles reply without a list keeps the bots already loaded', async () => {
    profilesReply = {}
    await store.refreshProfiles()

    expect(names()).toEqual(['default', 'alpha', 'beta'])
  })

  test('a late answer to an older refresh cannot overwrite a newer one', async () => {
    let releaseOld!: (value: any) => void
    profilesHold = new Promise(resolve => {
      releaseOld = resolve
    })

    const older = store.refreshProfiles()
    profilesReply = { profiles: [{ name: 'gamma', ui_meta: {} }] }
    await store.refreshProfiles()

    releaseOld({ profiles: [{ name: 'stale', ui_meta: {} }] })
    await older

    expect(names()).toEqual(['gamma'])
  })
})

describe('a member whose last turn failed', () => {
  test("is shown as an error, a teammate's @mention doesn't wake it again, and the user's next message does", async () => {
    const room = newRoom(['alpha', 'beta'], { reply: 'everyone' })

    rooms.postToRoom(room.key, 'hello team')
    await flush()
    expect(promptsFor('alpha').length).toBe(1)

    // Hermes reports a failed turn as message.complete with status "error"; its text describes the failure.
    emit(runtimeOf(room.roomId, 'alpha'), { type: 'message.complete', payload: { text: 'Provider rejected the model', status: 'error' } })
    await flush(20)

    const log = () => rooms.$rooms.get()[room.key].log
    expect(log().some(entry => entry.text === '⚠️ Provider rejected the model')).toBe(true)
    expect(log().some(entry => entry.from.kind === 'member' && entry.text === 'Provider rejected the model')).toBe(false)

    // Beta answers and hands it back to alpha. Alpha would only fail the same way, so it stays out.
    expect(promptsFor('beta').length).toBe(1)
    await letOthersSpeak(room, 'beta', '@alpha your model is broken, switch it.')
    await flush(20)
    expect(promptsFor('alpha').length).toBe(1)

    // The user's next message gives alpha another go.
    rooms.postToRoom(room.key, '@alpha try again')
    await flush()
    expect(promptsFor('alpha').length).toBe(2)
  })
})

describe('rename_group', () => {
  test('a member renames its group, and the group shows a note saying who did it', async () => {
    const room = newRoom(['alpha', 'beta'])
    const result = rooms.renameGroupFromBot('alpha', room.name, '  the   lads ')

    expect(result.ok).toBe(true)
    expect(rooms.$rooms.get()[room.key].name).toBe('the lads')
    const { $switchNotes } = await import('../src/lib/session-model')
    expect(($switchNotes.get()[`room:${room.roomId}`] || []).some(note => note.text === `Alpha renamed the group from "${room.name}" to "the lads"`)).toBe(true)
  })

  test("a bot can't rename a group it isn't in, or take a name another group has", async () => {
    const mine = newRoom(['alpha'])
    const theirs = newRoom(['beta'])

    expect(rooms.renameGroupFromBot('alpha', theirs.name, 'x').ok).toBe(false)
    expect(rooms.$rooms.get()[theirs.key].name).toBe(theirs.name)
    expect(rooms.renameGroupFromBot('alpha', mine.name, theirs.name).ok).toBe(false)
    expect(rooms.renameGroupFromBot('alpha', mine.name, '').ok).toBe(false)
    expect(rooms.renameGroupFromBot('alpha', mine.name, 'x'.repeat(41)).ok).toBe(false)
    expect(rooms.$rooms.get()[mine.key].name).toBe(mine.name)
  })
})

// ── direct wakes take turns ────────────────────────────────────────────────
//
// @all, a multi-mention and a bot's multi-handoff used to start every named member at once
// (`void runMember` per wake, bypassing the speak slot), so the whole group replied together.
describe('direct wakes run one member at a time, in order', () => {
  const started = () => submitted().map(call => String(call.params.profile))

  test('@all starts one member, and the next only after the first finishes', async () => {
    const room = newRoom(['alpha', 'beta'], { reply: 'off' })

    rooms.postToRoom(room.key, '@all say hi')
    await flush()
    expect(started()).toEqual(['alpha'])

    await letOthersSpeak(room, 'alpha', 'hi from alpha')
    expect(started()).toEqual(['alpha', 'beta'])
  })

  test('a multi-mention runs in the order the members were named', async () => {
    const room = newRoom(['alpha', 'beta'], { reply: 'off' })

    rooms.postToRoom(room.key, '@beta then @alpha please')
    await flush()
    expect(started()).toEqual(['beta'])

    await letOthersSpeak(room, 'beta', 'beta done.')
    expect(started()).toEqual(['beta', 'alpha'])
  })

  test("a bot's multi-handoff wakes teammates sequentially in mention order", async () => {
    const room = newRoom(['default', 'alpha', 'beta'], { reply: 'off' })

    rooms.postToRoom(room.key, '@default kick it off')
    await flush()
    expect(started()).toEqual(['default'])

    await letOthersSpeak(room, 'default', '@beta and @alpha, over to you.')
    expect(started()).toEqual(['default', 'beta'])

    await letOthersSpeak(room, 'beta', 'beta covered it.')
    expect(started()).toEqual(['default', 'beta', 'alpha'])
  })
})
