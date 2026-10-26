/**
 * Talking to a bot: one hidden "Bot Chat" session per bot (the same forever
 * session Hermes's Bots mode used), resumed into a runtime session on this
 * socket, plus the live event stream turned into chat messages. Rooms reuse
 * the same session + turn plumbing for each member.
 */
import { atom } from 'nanostores'

import { refreshExternalSoon } from './activity'
import { openApproval } from './approvals'
import { botReasoning } from './botconfig'
import { attachAll, rememberAttachments, splitAttachments, steerImages, toMsgAttachment, type Pending } from './attachments'
import { trackJobEvent } from './background'
import { ensureBotIdentity, identityRefusalText } from './bot-identity'
import { gateway, type GatewayEvent } from './gateway'
import { noteTurnEnd } from './memory'
import { native } from './native'
import { $profiles, clearTurnStatus, recordTurnStatus, refreshProfiles, setBusy } from './store'
import { CONTEXT_CLOSE, CONTEXT_OPEN, directoryInput, stripContext, teamContext, wrapContext } from './team'
import { dismissChatCards } from './ask'
import { noteProviderError } from './provider-notice'
import { refFromRaw, refLine, takeNotes } from './reactions'
import { threadFromRaw, threadLine, threadNote } from './threads'
import type { ChatMsg, PendingPrompt, ToolCall } from './types'

export const BOT_CHAT_TITLE = 'Bot Chat'

let uid = 0
export const newId = (prefix = 'm') => `${prefix}${Date.now().toString(36)}${(uid++).toString(36)}`

// ── sessions ──────────────────────────────────────────────────────────────
interface SessionRef {
  stored: string
  runtime?: string
  profile: string
}

const sessions = new Map<string, SessionRef>()
const runtimeOwner = new Map<string, string>()

gateway.onReconnect(() => {
  // A new socket means new runtime sessions; resume lazily on next use.
  for (const ref of sessions.values()) {
    ref.runtime = undefined
  }

  runtimeOwner.clear()
  void refreshProfiles().catch(() => undefined)

  for (const name of Object.keys($chats.get())) {
    void loadBotChat(name, true)
  }
})

const storageKey = (key: string) => `session:${key}`

export function rememberStored(key: string, stored: string) {
  try {
    localStorage.setItem(storageKey(key), stored)
  } catch {
    /* fine */
  }
}

export function storedFor(key: string): null | string {
  try {
    return localStorage.getItem(storageKey(key))
  } catch {
    return null
  }
}

interface CreateOpts {
  title: string
  roomPlumbing?: boolean
}

async function findOrCreateStored(key: string, profile: string, opts: CreateOpts): Promise<string> {
  const remembered = storedFor(key)

  if (remembered) {
    return remembered
  }

  if (!opts.roomPlumbing) {
    const row = $profiles.get().find(entry => entry.name === profile)
    const canonical = row?.canonical_session?.resolved_id || row?.canonical_session?.id

    if (canonical) {
      rememberStored(key, canonical)

      return canonical
    }

    try {
      const list = await gateway.request<{ sessions?: { id: string; resolved_id?: string; title?: string }[] }>('session.list', {
        profile,
        title: opts.title,
        limit: 200,
        include_hidden: true
      })

      const hit = (list?.sessions || []).find(s => s.title === opts.title)

      if (hit) {
        const id = hit.resolved_id || hit.id
        rememberStored(key, id)

        return id
      }
    } catch {
      /* create below */
    }
  }

  const created = await gateway.request<{ session_id: string; stored_session_id: string }>('session.create', {
    profile,
    title: opts.title,
    hidden: true,
    follow_profile_config: true,
    ...(opts.roomPlumbing ? { room_plumbing: true } : {})
  })

  rememberStored(key, created.stored_session_id)
  sessions.set(key, { stored: created.stored_session_id, runtime: created.session_id, profile })
  runtimeOwner.set(created.session_id, key)

  return created.stored_session_id
}

export interface ResumeResult {
  runtime: string
  messages: any[]
  running: boolean
  inflight?: { assistant?: string; user?: string } | null
}

export async function resumeSession(key: string, profile: string, opts: CreateOpts, omitMessages = false): Promise<ResumeResult> {
  let ref = sessions.get(key)

  if (!ref) {
    const stored = await findOrCreateStored(key, profile, opts)
    ref = sessions.get(key) || { stored, profile }
    sessions.set(key, ref)
  }

  try {
    const result = await gateway.request<any>(
      'session.resume',
      { session_id: ref.stored, profile, omit_messages: omitMessages },
      60_000
    )

    ref.runtime = result.session_id
    runtimeOwner.set(result.session_id, key)
    // Questions the bot is still waiting on come back answerable; withdrawn ones go away.
    restoreOpenRequests(result.session_id, result.open_requests)
    // Re-pin a model picked for this chat, or clear an old pin Hermes kept on the session.
    await reapplySessionModel(key, result.session_id, profile, result.info)

    return {
      runtime: result.session_id,
      messages: Array.isArray(result.messages) ? result.messages : [],
      running: Boolean(result.running),
      inflight: result.inflight
    }
  } catch (error) {
    // The stored session vanished (deleted elsewhere): start a fresh one.
    if (/not found|unknown session|no such/i.test(String((error as Error).message))) {
      try {
        localStorage.removeItem(storageKey(key))
      } catch {
        /* fine */
      }

      sessions.delete(key)
      const stored = await findOrCreateStored(key, profile, { ...opts })
      sessions.set(key, { stored, profile })

      return resumeSession(key, profile, opts, omitMessages)
    }

    throw error
  }
}

export function runtimeFor(key: string): string | undefined {
  return sessions.get(key)?.runtime
}

/** Every running Hermes session of one bot (its 1:1 chat and its seats in groups). */
export function liveSessionsOf(profile: string): { key: string; runtime: string }[] {
  return [...sessions.entries()].filter(([, ref]) => ref.profile === profile && ref.runtime).map(([key, ref]) => ({ key, runtime: ref.runtime as string }))
}

/**
 * Chats that were already open don't notice a tool server registered after they started (the This PC
 * link, for one). This asks Hermes to reload tools for each open profile so they pick it up now.
 */
export async function refreshBotTools(): Promise<boolean> {
  const seen = new Set<string>()
  let ok = false

  for (const ref of sessions.values()) {
    if (!ref.runtime || seen.has(ref.profile)) {
      continue
    }

    seen.add(ref.profile)

    try {
      const result = await gateway.request<{ status?: string }>('reload.mcp', { session_id: ref.runtime, profile: ref.profile, confirm: true }, 60_000)
      void native.log(`reload tools for ${ref.profile}: ${result?.status || 'done'}`)
      ok = true
    } catch (error) {
      void native.log(`reload tools for ${ref.profile} failed: ${String((error as Error)?.message || error)}`)
    }
  }

  return ok
}

export function keyForRuntime(runtime: string | undefined): string | undefined {
  return runtime ? runtimeOwner.get(runtime) : undefined
}

// ── event fan-out ─────────────────────────────────────────────────────────
type Sink = (event: GatewayEvent) => void
const sinks = new Map<string, Set<Sink>>()

gateway.on(event => {
  if (!event.session_id) {
    if (event.type === 'sessions.changed' || event.type === 'profiles.changed') {
      scheduleRefresh()
    }

    return
  }

  sinks.get(event.session_id)?.forEach(sink => sink(event))
})

let refreshTimer: null | ReturnType<typeof setTimeout> = null

function scheduleRefresh() {
  if (refreshTimer) {
    return
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshProfiles().catch(() => undefined)
  }, 1200)
}

export function listen(runtime: string, sink: Sink): () => void {
  let set = sinks.get(runtime)

  if (!set) {
    set = new Set()
    sinks.set(runtime, set)
  }

  set.add(sink)

  return () => set?.delete(sink)
}

// ── transcript → messages ─────────────────────────────────────────────────
function textOf(message: any): string {
  if (typeof message?.text === 'string') {
    return message.text
  }

  const content = message?.content

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : part?.type === 'text' ? String(part.text || '') : ''))
      .join('')
  }

  return ''
}

export function toolLabel(name: string, args?: any, context?: null | string, preview?: null | string): string {
  const hint =
    preview ||
    context ||
    (args && typeof args === 'object'
      ? String(args.command || args.query || args.url || args.path || args.file_path || args.prompt || args.name || args.group || '')
      : '')

  return hint ? String(hint).replace(/\s+/g, ' ').slice(0, 120) : ''
}

// Hermes wraps a mid-turn message in this marker when it lands in the running turn.
const STEER_OPEN = /^\s*\[OUT-OF-BAND USER MESSAGE[^\]]*\]\s*/
const STEER_CLOSE = /\s*\[\/OUT-OF-BAND USER MESSAGE\]\s*$/

const unwrapSteer = (text: string) => text.replace(STEER_OPEN, '').replace(STEER_CLOSE, '').trim()

// Hermes's cron delivery to Bot Chat (deliver="bot-chat") arrives as a turn with this header.
const ROUTINE_RESULT = /^\[Cronjob "([^"]*)" output — [^\]]*\]\s*/

export function transcriptToMessages(raw: any[]): ChatMsg[] {
  const out: ChatMsg[] = []

  for (const message of raw) {
    const role = String(message?.role || '')
    const at = Number(message?.timestamp || 0) * (Number(message?.timestamp || 0) < 1e12 ? 1000 : 1)

    if (role === 'user' && message?.display_kind === 'steer') {
      const text = unwrapSteer(textOf(message))

      if (text) {
        out.push({ id: `u${message.row_id ?? out.length}`, role: 'user', text, at, midTurn: 'steered' })
      }
    } else if (role === 'user' && ROUTINE_RESULT.test(textOf(message).trim())) {
      const raw = textOf(message).trim()
      const name = raw.match(ROUTINE_RESULT)?.[1] || 'Routine'
      out.push({ id: `r${message.row_id ?? out.length}`, role: 'system', routine: name, text: raw.replace(ROUTINE_RESULT, '').trim(), at })
    } else if (role === 'user') {
      const raw = textOf(message).trim()
      const { text, attachments } = splitAttachments(stripContext(raw))
      const head = raw.startsWith(CONTEXT_OPEN) ? raw.slice(0, raw.indexOf(CONTEXT_CLOSE) + 1 || raw.length) : ''
      const ref = head ? refFromRaw(head) : undefined
      const thread = head ? threadFromRaw(head) : undefined

      if ((text || attachments.length) && message?.display_kind !== 'hidden') {
        out.push({ id: `u${message.row_id ?? out.length}`, role: 'user', text, at, ...(attachments.length ? { attachments } : {}), ...(ref ? { ref } : {}), ...(thread ? { thread } : {}) })
      }
    } else if (role === 'assistant') {
      const text = textOf(message).trim()
      const last = out[out.length - 1]

      if (!text && last?.role === 'assistant') {
        continue
      }

      out.push({ id: `a${message.row_id ?? out.length}`, role: 'assistant', text, at, tools: [] })
    } else if (role === 'tool') {
      let last = out[out.length - 1]

      if (!last || last.role !== 'assistant') {
        last = { id: `t${message.row_id ?? out.length}`, role: 'assistant', text: '', at, tools: [] }
        out.push(last)
      }

      const name = String(message?.name || 'tool')
      last.tools = [
        ...(last.tools || []),
        {
          id: String(message?.tool_call_id || `${last.id}-${last.tools?.length || 0}`),
          name,
          label: toolLabel(name, message?.args, message?.context),
          done: true
        }
      ]
    }
  }

  // Tool-only assistant turns that precede their text read better merged.
  return out.filter(msg => msg.role !== 'assistant' || msg.text || (msg.tools && msg.tools.length))
}

// ── one turn's live stream, shared by 1:1 chats and rooms ─────────────────
export interface TurnView {
  messages: ChatMsg[]
  done: boolean
  error?: string
}

/** Applies one session's events to a message list (mutating copies). */
export function applyEvent(messages: ChatMsg[], event: GatewayEvent, from?: string): ChatMsg[] {
  const payload = event.payload || {}
  const list = messages.slice()
  // The reply in progress: the last message, or the one just above notes sent while it was working.
  let at = list.length - 1

  while (at >= 0 && list[at].role === 'user' && list[at].midTurn) {
    at--
  }

  const current = at >= 0 && list[at].role === 'assistant' && list[at].streaming ? list[at] : null

  const ensure = (): ChatMsg => {
    if (current) {
      const copy = { ...current, tools: [...(current.tools || [])] }
      list[at] = copy

      return copy
    }

    const created: ChatMsg = { id: newId('s'), role: 'assistant', text: '', at: Date.now(), tools: [], streaming: true, from }
    list.push(created)

    return created
  }

  switch (event.type) {
    case 'message.start':
      ensure()
      break
    case 'message.delta': {
      const msg = ensure()
      msg.text += String(payload.text || '')
      break
    }
    case 'message.interim': {
      const msg = ensure()

      if (!payload.already_streamed && payload.text) {
        msg.text = msg.text ? `${msg.text}\n\n${payload.text}` : String(payload.text)
      }

      // Text sent before a tool call is working out loud, not the answer: the group keeps it in Work.
      msg.streaming = false
      msg.interim = true
      list.push({ id: newId('s'), role: 'assistant', text: '', at: Date.now(), tools: [], streaming: true, from })
      break
    }
    case 'tool.start': {
      const msg = ensure()
      const tool: ToolCall = {
        id: String(payload.tool_id || newId('t')),
        name: String(payload.name || 'tool'),
        label: toolLabel(String(payload.name || ''), payload.args, payload.context, payload.preview),
        done: false
      }
      msg.tools = [...(msg.tools || []).filter(t => t.id !== tool.id), tool]
      break
    }
    case 'tool.complete': {
      const msg = ensure()
      msg.tools = (msg.tools || []).map(tool =>
        tool.id === String(payload.tool_id)
          ? { ...tool, done: true, summary: payload.summary ? String(payload.summary).slice(0, 200) : undefined }
          : tool
      )
      break
    }
    case 'message.complete': {
      const msg = ensure()
      const finalText = typeof payload.text === 'string' ? payload.text : ''
      const failed = payload.status === 'error' || Boolean(payload.error)

      // A failed turn's text is Hermes's description of the failure, not a reply: it goes on the
      // error line, so a group never posts it as if the bot had answered.
      if (!failed && finalText && finalText.length >= msg.text.length) {
        msg.text = finalText
      }

      msg.streaming = false
      msg.tools = (msg.tools || []).map(tool => ({ ...tool, done: true }))

      if (payload.status === 'interrupted') {
        msg.stopped = true
      }

      if (failed) {
        // The "no provider" error is shown once, as the provider banner; a red bubble repeated it.
        if (!noteProviderError(payload.error || payload.failure_reason || finalText)) list.push({
          id: newId('e'),
          role: 'error',
          text: String(payload.error || payload.failure_reason || finalText || 'The bot hit an error'),
          at: Date.now(),
          from
        })
      }

      break
    }
    case 'error': {
      if (current) {
        list[at] = { ...current, streaming: false }
      }

      if (!noteProviderError(payload.message)) list.push({ id: newId('e'), role: 'error', text: String(payload.message || 'Something went wrong'), at: Date.now(), from })
      break
    }
    default:
      return messages
  }

  // Drop empty, finished placeholders.
  return list.filter(msg => !(msg.role === 'assistant' && !msg.streaming && !msg.text && !(msg.tools || []).length))
}

export const isTurnEnd = (event: GatewayEvent) => event.type === 'message.complete' || event.type === 'error'

// ── 1:1 bot chats ─────────────────────────────────────────────────────────
export interface ChatState {
  messages: ChatMsg[]
  loading: boolean
  running: boolean
  error?: string
}

export const $chats = atom<Record<string, ChatState>>({})
const chatListeners = new Map<string, () => void>()

/**
 * History is on screen only once Hermes has answered. Cards, approvals and reactions live on this
 * device, so drawing them before the transcript arrives flashes a stale screen for a few seconds.
 * A reconnect refresh keeps the messages already shown.
 */
export const chatShowsHistory = (state?: ChatState) => Boolean(state && (!state.loading || state.messages.length))

// ── offline outbox ────────────────────────────────────────────────────────
// A message typed while Hermes is unreachable is held here, shown as waiting, and sent in order once
// the connection is back — one per turn, so a second one never steers into the first's reply.
export interface OutboxItem {
  id: string
  text: string
  attachments: Pending[]
  opts: SendOptions
  at: number
}

export const $outbox = atom<Record<string, OutboxItem[]>>({})
const flushing = new Set<string>()

const outboxOf = (name: string) => $outbox.get()[name] || []

function setOutbox(name: string, items: OutboxItem[]) {
  const all = { ...$outbox.get() }

  if (items.length) {
    all[name] = items
  } else {
    delete all[name]
  }

  $outbox.set(all)
}

export function outboxMessages(name: string): ChatMsg[] {
  return outboxOf(name).map(item => ({
    id: item.id,
    role: 'user',
    text: item.text,
    at: item.at,
    waiting: true,
    ...(item.attachments.length ? { attachments: item.attachments.map(toMsgAttachment) } : {})
  }))
}

const connected = () => gateway.state.get() === 'open'

async function flushOutbox(name: string) {
  if (flushing.has(name) || !connected() || $chats.get()[name]?.running || $chats.get()[name]?.loading) {
    return
  }

  const [next, ...rest] = outboxOf(name)

  if (!next) {
    return
  }

  flushing.add(name)
  setOutbox(name, rest)

  try {
    await deliver(name, next.text, next.attachments, next.opts, next)
  } finally {
    flushing.delete(name)
  }
}

gateway.state.listen(state => {
  if (state !== 'open') {
    return
  }

  for (const name of Object.keys($outbox.get())) {
    void flushOutbox(name)
  }
})

function patchChat(name: string, update: (state: ChatState) => ChatState) {
  const all = $chats.get()
  const prev = all[name] || { messages: [], loading: false, running: false }
  $chats.set({ ...all, [name]: update(prev) })
}

const botKey = (name: string) => `bot:${name}`

/** A reply that was still streaming when the session was reloaded and isn't in the fresh transcript. */
export function keptPartial(before: ChatMsg[], transcript: ChatMsg[]): ChatMsg | null {
  const last = before[before.length - 1]

  if (!last || last.role !== 'assistant' || !last.streaming || !last.text.trim()) return null

  const tail = transcript.filter(msg => msg.role === 'assistant').slice(-3)
  if (tail.some(msg => msg.text.includes(last.text.trim().slice(0, 200)))) return null

  return { ...last, streaming: false, stopped: true }
}

export async function loadBotChat(name: string, force = false) {
  const existing = $chats.get()[name]

  if (existing && !force && (existing.loading || existing.messages.length || existing.running)) {
    return
  }

  patchChat(name, state => ({ ...state, loading: true, error: undefined }))

  try {
    const result = await resumeSession(botKey(name), name, { title: BOT_CHAT_TITLE })
    const messages = transcriptToMessages(result.messages)

    if (result.running && result.inflight?.assistant) {
      messages.push({ id: newId('s'), role: 'assistant', text: result.inflight.assistant, at: Date.now(), tools: [], streaming: true })
    } else {
      // Hermes restarted mid-reply: the transcript doesn't have the half-streamed text. Keep it, marked.
      const partial = keptPartial(existing?.messages || [], messages)
      if (partial) messages.push(partial)
    }

    attachBotListener(name, result.runtime)
    patchChat(name, () => ({ messages, loading: false, running: result.running }))
    setBusy(name, result.running)
    void flushOutbox(name)
  } catch (error) {
    patchChat(name, state => ({ ...state, loading: false, error: String((error as Error).message || error) }))
  }
}

function attachBotListener(name: string, runtime: string) {
  chatListeners.get(name)?.()
  chatListeners.set(
    name,
    listen(runtime, event => {
      trackJobEvent(name, event)
      patchChat(name, state => ({
        ...state,
        messages: applyEvent(state.messages, event),
        running: isTurnEnd(event) ? false : event.type === 'message.start' || event.type === 'message.delta' ? true : state.running
      }))

      if (isTurnEnd(event)) {
        setBusy(name, false)
        clearTurnStatus(name)
        refreshExternalSoon()
        scheduleRefresh()
        noteTurnEnd(name)
        void flushOutbox(name)
      } else if (event.type === 'message.start') {
        setBusy(name, true)
      }
    })
  )
}

// ── per-message thinking ──────────────────────────────────────────────────
// A boost is a session-scoped `reasoning` override on the bot's chat session, so the bot's own
// setting (and its other chats) never change. The next message without a boost puts it back.
const boostKey = (key: string) => `thinking:${key}`

function boosted(key: string) {
  try {
    return localStorage.getItem(boostKey(key)) || ''
  } catch {
    return ''
  }
}

function markBoost(key: string, level: string) {
  try {
    level ? localStorage.setItem(boostKey(key), level) : localStorage.removeItem(boostKey(key))
  } catch {
    /* fine */
  }
}

/** Sets this one turn's thinking level, or restores the bot's own level after a boosted turn. */
export async function applyThinking(key: string, runtime: string, profile: string, level: string) {
  const current = boosted(key)

  if (level ? current === level : !current) {
    return
  }

  // Hermes has no "unset" for a session override; when the bot has no level of its own, medium is
  // what every provider treats as its default.
  const value = level || botReasoning(profile) || 'medium'
  await gateway.request('config.set', { key: 'reasoning', value, session_id: runtime, profile })
  markBoost(key, level)
}

export interface SendOptions {
  /** Thinking level for this message only (`max`, `high`, …); empty uses the bot's own setting. */
  reasoning?: string
  /** Reply in a thread: the root's id and text (the bot is told which message it's under). */
  thread?: { root: string; text: string }
  /**
   * The group member this message answers. Set by the composer's reply, so a reply wakes only that
   * member instead of every bot the quoted text happens to name. 1:1 sends never set it.
   */
  answerTo?: string
}

export async function sendToBot(name: string, text: string, attachments: Pending[] = [], opts: SendOptions = {}) {
  const body = text.trim()

  if (!body && !attachments.length) {
    return
  }

  // Offline, or earlier messages still waiting: hold it in order instead of failing it.
  if (!connected() || outboxOf(name).length) {
    setOutbox(name, [...outboxOf(name), { id: newId('w'), text: body, attachments, opts, at: Date.now() }])
    void flushOutbox(name)

    return
  }

  await deliver(name, body, attachments, opts)
}

/** True when the request never left this machine because the socket was down (safe to hold and resend). */
const neverSent = (error: unknown) => /reconnecting|Not connected to Hermes/i.test(String((error as Error)?.message || error))

async function deliver(name: string, body: string, attachments: Pending[], opts: SendOptions, held?: OutboxItem) {
  // Before anything is said on this bot's behalf, prove the bot is registered as its own groups
  // route on the Hermes it is about to talk to. A profile cloned from default carries default's URL
  // and default's valid bearer, and that pair connects fine — as default — so without this a first
  // turn can be sent by, answered by, and attributed to the wrong bot. Refusals are shown, not
  // swallowed: nothing is sent and the user is told why.
  const identity = await ensureBotIdentity(name)

  if (!identity.ready) {
    void native.log(`identity not confirmed for ${name}: ${identity.error || 'refused'}`)
    patchChat(name, state => ({
      ...state,
      messages: [
        ...state.messages,
        { id: newId('e'), role: 'error', text: identityRefusalText(name, identity), at: Date.now() }
      ]
    }))

    return
  }

  // A typed message leaves any open question card unanswered (an answer marks its card first).
  dismissChatCards(botKey(name))

  const runtime = runtimeFor(botKey(name))

  if (runtime && $chats.get()[name]?.running && (await sendWhileWorking(name, runtime, body, attachments))) {
    return
  }

  // The id the bot sees for this message (for reactions); kept in the hidden context so a reload
  // reads it back from Hermes's transcript.
  const ref = newId('u')

  patchChat(name, state => ({
    ...state,
    running: true,
    messages: [
      ...state.messages,
      {
        id: ref,
        ref,
        role: 'user',
        text: body,
        at: Date.now(),
        ...(attachments.length ? { attachments: attachments.map(toMsgAttachment) } : {}),
        ...(opts.reasoning ? { thinking: opts.reasoning } : {}),
        ...(opts.thread ? { thread: opts.thread.root } : {})
      },
      { id: newId('s'), role: 'assistant', text: '', at: Date.now(), tools: [], streaming: true }
    ]
  }))
  setBusy(name, true)
  // Recorded where the turn is claimed, so the status and the busy flag can never disagree.
  recordTurnStatus(name, body)

  try {
    let runtime = runtimeFor(botKey(name))

    if (!runtime) {
      runtime = (await resumeSession(botKey(name), name, { title: BOT_CHAT_TITLE }, true)).runtime
      attachBotListener(name, runtime)
    }

    let prompt = body

    if (attachments.length) {
      const { markers, refs } = await attachAll(runtime, name, attachments)
      void rememberAttachments(botKey(name), attachments, refs)
      prompt = [...markers, body].filter(Boolean).join('\n')
    }

    // Who's on the team, the time and who's busy: the chat view strips this back out of history.
    // Plus this message's id and any reactions the user left since the bot's last turn.
    const inThread = opts.thread ? [threadLine(opts.thread.root), threadNote(opts.thread.root, opts.thread.text)] : []
    prompt = wrapContext([teamContext(runtime, directoryInput(name)), refLine(ref), ...inThread, ...takeNotes(botKey(name))].filter(Boolean).join('\n'), prompt)

    await applyThinking(botKey(name), runtime, name, opts.reasoning || '')
    await gateway.request('prompt.submit', { session_id: runtime, profile: name, text: prompt }, 120_000)
  } catch (error) {
    setBusy(name, false)
    clearTurnStatus(name)

    // The socket dropped before this left the machine: take it back off the thread and hold it.
    if (neverSent(error)) {
      patchChat(name, state => ({ ...state, running: false, messages: state.messages.filter(msg => msg.id !== ref && !(msg.streaming && !msg.text)) }))
      setOutbox(name, [held || { id: newId('w'), text: body, attachments, opts, at: Date.now() }, ...outboxOf(name)])

      return
    }

    patchChat(name, state => ({
      ...state,
      running: false,
      messages: [
        ...state.messages.filter(msg => !(msg.streaming && !msg.text)),
        { id: newId('e'), role: 'error', text: String((error as Error).message || error), at: Date.now() }
      ]
    }))
  }
}

/**
 * A message typed while the bot is mid-reply goes INTO the running turn at its next safe step.
 * Text rides `session.steer`; pictures ride `session.steer_media` as native image content, so the
 * model sees the bytes, not a filename. A failed steer is reported, never quietly turned into an
 * after-reply queue. A compression demotion (`delivery: next_turn`) is said out loud.
 * Only non-picture files still wait for the reply to end, and that is labelled as queued.
 * Returns false when the turn had already ended, so the caller sends it as a normal message.
 */
async function sendWhileWorking(name: string, runtime: string, body: string, attachments: Pending[]): Promise<boolean> {
  const id = newId('u')
  const note = (midTurn: ChatMsg['midTurn']) =>
    patchChat(name, state => ({ ...state, messages: state.messages.map(msg => (msg.id === id ? { ...msg, midTurn } : msg)) }))
  const fail = (text: string) =>
    patchChat(name, state => ({ ...state, messages: [...state.messages, { id: newId('e'), role: 'error', text, at: Date.now() }] }))

  patchChat(name, state => ({
    ...state,
    messages: [
      ...state.messages,
      { id, role: 'user', text: body, at: Date.now(), midTurn: 'steered', ...(attachments.length ? { attachments: attachments.map(toMsgAttachment) } : {}) }
    ]
  }))

  const drop = () => patchChat(name, state => ({ ...state, messages: state.messages.filter(msg => msg.id !== id) }))
  const images = attachments.filter(item => item.kind === 'image')
  const files = attachments.filter(item => item.kind !== 'image')

  try {
    if (!files.length) {
      const steered = images.length
        ? await gateway.request<{ status?: string; delivery?: string }>(
            'session.steer_media',
            { session_id: runtime, profile: name, text: body, images: await steerImages(images) },
            120_000
          )
        : await gateway.request<{ status?: string; delivery?: string }>('session.steer', { session_id: runtime, profile: name, text: body })

      if (steered?.status === 'rejected') {
        // The reply finished just now: send it as a fresh message.
        drop()

        return false
      }

      if (steered?.status !== 'queued' && steered?.status !== 'steered') {
        throw new Error(`Hermes did not accept the correction (${steered?.status || 'no status'})`)
      }

      if (images.length) {
        void rememberAttachments(botKey(name), images)
      }

      if (steered.delivery === 'next_turn') {
        note('queued')
        fail(`${name} is compressing its context, so this correction is deferred to the next turn instead of the current one.`)
      }

      return true
    }

    // Non-picture files cannot enter a running turn as content; they wait for this reply to end,
    // and the bubble says so.
    const { markers, refs } = await attachAll(runtime, name, attachments)
    void rememberAttachments(botKey(name), attachments, refs)
    const prompt = [...markers, body].filter(Boolean).join('\n')
    await gateway.request('prompt.submit', { session_id: runtime, profile: name, text: prompt, queued: true }, 120_000)
    note('queued')

    return true
  } catch (error) {
    note(undefined)
    fail(`Correction not delivered to ${name}: ${String((error as Error).message || error)}`)

    return true
  }
}

export async function stopBot(name: string) {
  const runtime = runtimeFor(botKey(name))

  if (runtime) {
    await gateway.request('session.interrupt', { session_id: runtime, profile: name }).catch(() => undefined)
  }

  // Whatever had streamed so far stays on screen, marked as stopped.
  patchChat(name, state => ({ ...state, messages: state.messages.map(msg => (msg.role === 'assistant' && msg.streaming && msg.text.trim() ? { ...msg, stopped: true } : msg)) }))
}

// ── questions the agent asks back (approvals, clarify, secrets) ───────────
export const $prompts = atom<PendingPrompt[]>([])

gateway.onServerRequest((method, params, id) => {
  if (!['approval', 'clarify', 'sudo', 'secret', 'vault.code', 'display.install.sudo'].includes(method)) {
    return Promise.reject(Object.assign(new Error(`${method} isn't supported in NexurBots`), { code: -32601 }))
  }

  return new Promise((resolve, reject) => {
    // Already on screen (a reconnect re-delivered it): keep the one card, answer through it.
    const existing = $prompts.get().find(p => p.id === id)

    if (existing) {
      existing.rebind(resolve, reject)

      return
    }

    // Risky actions from a bot's own chat or group seat get an inline card in that chat (approvals.ts).
    if (method === 'approval' && openApproval(id, params || {}, keyForRuntime(String(params?.session_id || '')), resolve)) {
      return
    }

    let settle = { resolve, reject }
    const prompt: PendingPrompt = {
      id,
      method,
      sessionId: String(params?.session_id || ''),
      params: params || {},
      resolve: value => {
        $prompts.set($prompts.get().filter(p => p.id !== id))
        settle.resolve(value)
      },
      reject: error => {
        $prompts.set($prompts.get().filter(p => p.id !== id))
        settle.reject(error)
      },
      rebind: (nextResolve, nextReject) => {
        // The old socket is gone; its pending reply would go nowhere. Answer on the new one.
        settle = { resolve: nextResolve, reject: nextReject }
      }
    }

    $prompts.set([...$prompts.get(), prompt])
  })
})

/**
 * After `session.resume`: put back every question Hermes is still waiting on for this session, and
 * drop cards for this session that Hermes no longer has open (withdrawn while we were away).
 */
export function restoreOpenRequests(runtime: string, open: unknown) {
  const list = Array.isArray(open) ? (open as { id?: unknown; method?: unknown; params?: any }[]) : []
  const live = new Set(list.map(entry => String(entry?.id || '')).filter(Boolean))

  $prompts.set($prompts.get().filter(p => p.sessionId !== runtime || live.has(p.id)))

  for (const entry of list) {
    const id = String(entry?.id || '')
    const method = String(entry?.method || '')

    if (id && method) {
      gateway.redeliverServerRequest(id, method, { session_id: runtime, ...(entry.params || {}) })
    }
  }
}

gateway.on(event => {
  if (event.type === 'approval.cancelled') {
    // Broadcast to every client, so the session is in the payload.
    const sid = String(event.payload?.session_id || event.session_id || '')
    $prompts.set($prompts.get().filter(p => p.sessionId !== sid || p.method !== 'approval'))
  } else if (event.type === 'request.cancel' && event.payload?.id) {
    // Hermes stopped waiting (timeout, stop, answered elsewhere): drop just that card.
    $prompts.set($prompts.get().filter(p => p.id !== String(event.payload.id)))
  }
})

import { reapplySessionModel, useLiveSessions, useRuntimeLookup } from './session-model'
useRuntimeLookup(runtimeFor)
useLiveSessions(liveSessionsOf)

