/**
 * Group chats. A room is a shared log; each member bot gets its own hidden
 * session per room, and a "round" hands each speaking member the messages it
 * hasn't seen yet. The Lead answers first and pulls teammates in with
 * @mentions. Rooms are stored on the default profile's
 * ui_meta['hermes-bots-groups'] (the format Hermes's Bots mode used), with the
 * full local log kept on this device.
 */
import { atom } from 'nanostores'

import { refreshExternalSoon } from './activity'
import { attachAll, blobOf, rememberAttachments, steerImages, toMsgAttachment, type Pending } from './attachments'
import { applyEvent, isTurnEnd, listen, newId, resumeSession, runtimeFor, transcriptToMessages } from './chat'
import { gateway, type GatewayEvent } from './gateway'
import { botOffline, hostOf, machineLabel } from './hosts'
import { addSwitchNote } from './session-model'
import { noteTurnEnd } from './memory'
import { $allBots, $busy, $profiles, $userName, claimBusy, clearTurnStatus, recordTurnStatus, refreshProfiles, releaseBusy } from './store'
import { directoryInput, GROUP_POST_TOOL, setRoomsSource, teamContext } from './team'
import { roomRef, takeNotes } from './reactions'
import type { AskCard, Bot, BotFile, HelpCard, SecretCard, ChatMsg, Room, RoomEntry, RoomMember, RoomSettings, WorkItem } from './types'

const SYNC_KEY = 'hermes-bots-groups'
const SYNC_MAX_BYTES = 46_000
const SYNC_MESSAGES = 16
const SYNC_TEXT = 1200
const PASS = /^\s*[(\[]?\s*pass\s*[)\]]?\.?\s*$/i
/** Members a room syncs. The envelope's byte cap still bounds the total. */
const SYNC_MEMBERS = 24
// Work notes sync under their own key, so progress never crowds the group's 16 messages.
const WORK_KEY = 'hermes-bots-work'
const WORK_MAX_BYTES = 24_000
const WORK_PER_ROOM = 40
const WORK_TEXT = 400
/** A member's turn ends if Hermes sends nothing at all for this long (a dropped socket, a wedged run). */
const TURN_IDLE_MS = 5 * 60_000
// The clock the scheduler actually arms. A module-level seam so a test can shorten it; production
// never touches it, so the 5-minute default holds in the app.
let turnIdleMs = TURN_IDLE_MS

/** Test seam: shorten/restore the per-turn idle clock. Production uses the 5-minute default. */
export function setTurnIdleMs(ms: number) {
  turnIdleMs = ms
}

/** Handoffs only count when a bot @mentions someone in its own words, not inside code or a quote. */
const ownWords = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter(line => !/^\s*>/.test(line))
    .join('\n')

export const $rooms = atom<Record<string, Room>>({})
setRoomsSource(() => Object.values($rooms.get()))
/** One room may have several members writing at once; keep each live reply by member. */
export interface RoomTypingTurn {
  member: string
  messages: ChatMsg[]
  thread?: string
}
function safeRecord<T>(source?: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, source || {})
}

export const $roomTyping = atom<Record<string, Record<string, RoomTypingTurn>>>(safeRecord())
export const $roomRunning = atom<Record<string, boolean>>({})
/** Work notes from every group, oldest first. The Work pane shows them per bot. */
export const $roomWork = atom<WorkItem[]>([])

/** Which process runs group turns: this app, or the VM runner (runner/host.ts). A group's turns run
 * only in the process that owns it, so the app and the runner never both answer the same message. */
export type Conductor = 'app' | 'runner'
let conductor: Conductor = 'app'

export function setConductor(role: Conductor) {
  conductor = role
}

export function ownsTurns(room: Room): boolean {
  return (roomSettings(room).runner ? 'runner' : 'app') === conductor
}

let deleted: Record<string, number> = {}

const offlineSaid = new Map<string, number>()

const roomKey = (room: { roomId?: string; name: string }) => (room.roomId ? `id:${room.roomId}` : room.name)

// ── local full logs ───────────────────────────────────────────────────────
function localLog(roomId: string): RoomEntry[] {
  try {
    const raw = localStorage.getItem(`room-log:${roomId}`)

    return raw ? (JSON.parse(raw) as RoomEntry[]) : []
  } catch {
    return []
  }
}

function saveLocalLog(room: Room) {
  try {
    // Thumbnails live in the attachment library, not in this (small) localStorage log.
    const slim = room.log.slice(-400).map(entry =>
      entry.attachments ? { ...entry, attachments: entry.attachments.map(({ thumb: _thumb, ...rest }) => rest) } : entry
    )

    localStorage.setItem(`room-log:${room.roomId}`, JSON.stringify(slim))
  } catch {
    /* quota: the synced tail still exists */
  }
}

const entryKey = (entry: RoomEntry) => entry.id || `${entry.at}|${entry.from.kind}|${entry.from.name}|${entry.text.slice(0, 80)}`

function mergeLogs(a: RoomEntry[], b: RoomEntry[]): RoomEntry[] {
  const seen = new Map<string, RoomEntry>()

  for (const entry of [...a, ...b]) {
    const key = entryKey(entry)
    const prev = seen.get(key)

    // Prefer the untruncated copy. Reactions: the later copy's, when it has any record of them
    // (`{}` means they were all removed), so a removal isn't undone by an older copy.
    const reactions = entry.reactions !== undefined ? entry.reactions : prev?.reactions
    // A question card: the copy furthest along (open → answered/dismissed) wins.
    const ask = !prev?.ask ? entry.ask : !entry.ask || entry.ask.status === 'open' ? prev.ask : entry.ask
    const extra = { ...(reactions !== undefined ? { reactions } : {}), ...(ask ? { ask } : {}) }

    if (!prev || (entry.text || '').length > (prev.text || '').length) {
      seen.set(key, { ...entry, ...extra })
    } else {
      seen.set(key, { ...prev, ...extra })
    }
  }

  return [...seen.values()].sort((x, y) => x.at - y.at)
}

// ── load / save ───────────────────────────────────────────────────────────
function defaultRow() {
  return $profiles.get().find(row => row.name === 'default') || $profiles.get().find(row => row.is_default)
}

const REPLY_MODES = ['everyone', 'lead', 'mentions'] as const
const STOP_MODES = ['turn', 'sticky'] as const

/** Keeps only valid, bounded settings so a bad envelope can't break a room. */
export function cleanSettings(raw: unknown): RoomSettings | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }

  const input = raw as Record<string, unknown>
  const out: RoomSettings = {}

  if ((REPLY_MODES as readonly unknown[]).includes(input.reply)) {
    out.reply = input.reply as RoomSettings['reply']
  }

  if ((STOP_MODES as readonly unknown[]).includes(input.stop)) {
    out.stop = input.stop as RoomSettings['stop']
  }

  const turns = Math.round(Number(input.maxTurns))

  if (Number.isFinite(turns) && turns >= 1) {
    out.maxTurns = Math.min(24, turns)
  }

  if (typeof input.instructions === 'string' && input.instructions.trim()) {
    out.instructions = input.instructions.trim().slice(0, 800)
  }

  if (typeof input.runner === 'boolean') {
    out.runner = input.runner
  }

  return Object.keys(out).length ? out : undefined
}

/** A group's settings with every default filled in (the defaults are how Grok Bot behaves). */
export function roomSettings(room: Room): Required<Omit<RoomSettings, 'instructions'>> & { instructions: string } {
  const own = room.settings || {}

  return {
    reply: own.reply || 'everyone',
    stop: own.stop || 'turn',
    maxTurns: own.maxTurns || Math.min(24, Math.max(8, room.members.length * 2)),
    instructions: own.instructions || '',
    runner: own.runner === true
  }
}

export function loadRooms(force = false) {
  // Local edits waiting to sync win over the server's older copy.
  if (!force && (saveTimer || saving)) {
    return
  }

  loadWork(force)

  const row = defaultRow()

  if (!row?.ui_meta?.[SYNC_KEY]) {
    return
  }

  const envelope = (row.ui_meta[SYNC_KEY] || {}) as { rooms?: Record<string, any>; deleted?: Record<string, number> }
  deleted = { ...(envelope.deleted || {}) }
  const next: Record<string, Room> = {}
  const current = $rooms.get()

  for (const [key, raw] of Object.entries(envelope.rooms || {})) {
    if (!raw || deleted[key]) {
      continue
    }

    const roomId = String(raw.roomId || key.replace(/^id:/, '') || newId('r'))
    const synced: RoomEntry[] = (Array.isArray(raw.log) ? raw.log : []).map((entry: any, index: number) => ({
      id: String(entry.id || `${roomId}-${index}-${entry.at}`),
      at: Number(entry.at || 0),
      from: { kind: entry?.from?.kind === 'member' ? 'member' : 'user', name: String(entry?.from?.name || 'You') },
      text: String(entry.text || ''),
      thread: entry.thread,
      ...(entry.via === 'dm' ? { via: 'dm' as const } : {}),
      ...(entry.reactions && typeof entry.reactions === 'object' ? { reactions: cleanReactions(entry.reactions) } : {}),
      ...(entry.ask && typeof entry.ask === 'object' && Array.isArray(entry.ask.options) ? { ask: entry.ask as AskCard } : {}),
      ...(Array.isArray(entry.files) ? { files: cleanFiles(entry.files) } : {}),
      ...(typeof entry.threadOf === 'string' && entry.threadOf ? { threadOf: entry.threadOf.slice(0, 64) } : {}),
      ...(entry.helpAsk && typeof entry.helpAsk === 'object' ? { helpAsk: { instruction: String(entry.helpAsk.instruction || '') } } : {}),
      ...(entry.secretAsk && typeof entry.secretAsk === 'object' ? { secretAsk: { name: String(entry.secretAsk.name || ''), label: String(entry.secretAsk.label || '') } } : {})
    }))

    const room: Room = {
      key,
      name: String(raw.name || key),
      roomId,
      members: (Array.isArray(raw.members) ? raw.members : [])
        .map((m: any) => ({ name: String(m?.name || ''), handle: m?.handle }))
        .filter((m: RoomMember) => m.name),
      log: mergeLogs(mergeLogs(localLog(roomId), synced), current[key]?.log || []),
      image: typeof raw.image === 'string' ? raw.image : undefined,
      revision: Number(raw.revision || 0),
      holds: raw.holds && typeof raw.holds === 'object' ? raw.holds : undefined,
      settings: cleanSettings(raw.settings),
      quiet: Array.isArray(raw.quiet) ? raw.quiet.map(String).slice(0, SYNC_MEMBERS) : undefined
    }

    next[key] = room
  }

  // Rooms made here and not yet synced stay.
  for (const [key, room] of Object.entries(current)) {
    if (!next[key] && !deleted[key] && room.log.length === 0) {
      next[key] = room
    }
  }

  $rooms.set(next)
}

let saveTimer: null | ReturnType<typeof setTimeout> = null
let saving = false

function scheduleSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
  }

  saveTimer = setTimeout(() => {
    saveTimer = null
    saving = true
    void saveRooms()
      .catch(error => console.warn('room sync failed', error))
      .finally(() => {
        saving = false
      })
  }, 1200)
}

function compactText(text: string) {
  return text.length > SYNC_TEXT ? { text: `${text.slice(0, SYNC_TEXT)}… [truncated]`, truncated: true } : { text }
}

function envelopeFor(rooms: Record<string, Room>) {
  const out: Record<string, any> = {}
  const envelope: Record<string, any> = { version: 3, updatedAt: Date.now(), rooms: out }
  const bounded = Object.fromEntries(
    Object.entries(deleted)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 64)
  )

  if (Object.keys(bounded).length) {
    envelope.deleted = bounded
  }

  const ranked = Object.values(rooms).sort((a, b) => (b.log.at(-1)?.at || 0) - (a.log.at(-1)?.at || 0))

  for (const room of ranked) {
    const compact: Record<string, any> = {
      name: room.name.slice(0, 64),
      roomId: room.roomId,
      log: room.log.slice(-SYNC_MESSAGES).map(entry => ({
        id: entry.id,
        from: { kind: entry.from.kind, name: entry.from.name.slice(0, 128) },
        at: entry.at,
        ...(entry.thread ? { thread: entry.thread } : {}),
        ...(entry.via ? { via: entry.via } : {}),
        ...(entry.reactions ? { reactions: entry.reactions } : {}),
        ...(entry.ask ? { ask: entry.ask } : {}),
        ...(entry.secretAsk ? { secretAsk: entry.secretAsk } : {}),
        ...(entry.helpAsk ? { helpAsk: entry.helpAsk } : {}),
        ...(entry.files?.length ? { files: entry.files } : {}),
        ...(entry.threadOf ? { threadOf: entry.threadOf } : {}),
        ...compactText(entry.text)
      })),
      holdDetection: true,
      revision: Number(room.revision || 0),
      members: room.members.slice(0, SYNC_MEMBERS).map(m => ({ name: m.name, ...(m.handle ? { handle: m.handle } : {}) })),
      ...(room.image && room.image.length < 24_000 ? { image: room.image } : {}),
      ...(room.holds && Object.keys(room.holds).length ? { holds: room.holds } : {}),
      ...(room.settings && Object.keys(room.settings).length ? { settings: cleanSettings(room.settings) } : {}),
      ...(room.quiet?.length ? { quiet: room.quiet.slice(0, SYNC_MEMBERS) } : {})
    }

    out[room.key] = compact

    while (compact.log.length > 1 && JSON.stringify(envelope).length > SYNC_MAX_BYTES) {
      compact.log.shift()
    }

    if (JSON.stringify(envelope).length > SYNC_MAX_BYTES) {
      delete out[room.key]
    }
  }

  return envelope
}

export async function saveRooms() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = defaultRow()

    if (!row) {
      return
    }

    const revision = row.ui_meta_revisions?.[SYNC_KEY]
    const result = await gateway.request<any>('profiles.configure', {
      name: row.name,
      profile: row.name,
      ui_meta: { [SYNC_KEY]: envelopeFor($rooms.get()) },
      ...(typeof revision === 'number' ? { ui_meta_expected_revisions: { [SYNC_KEY]: revision } } : {})
    })

    if (result?.applied?.ui_meta_conflicts && Object.keys(result.applied.ui_meta_conflicts).length) {
      // Someone else wrote rooms: merge theirs in and try again.
      const local = $rooms.get()
      await refreshProfiles()
      loadRooms(true)
      const merged = { ...$rooms.get() }

      for (const [key, room] of Object.entries(local)) {
        merged[key] = merged[key] ? { ...merged[key], log: mergeLogs(merged[key].log, room.log) } : room
      }

      $rooms.set(merged)
      continue
    }

    const revisions = result?.applied?.ui_meta_revisions || {}
    $profiles.set(
      $profiles.get().map(entry =>
        entry.name === row.name
          ? {
              ...entry,
              ui_meta: { ...(entry.ui_meta || {}), [SYNC_KEY]: envelopeFor($rooms.get()) },
              ui_meta_revisions: { ...(entry.ui_meta_revisions || {}), ...revisions }
            }
          : entry
      )
    )

    return
  }
}

// ── work notes: what a bot worked out loud before its answer, kept out of the group log ──
/** Newest first within the per-group and byte limits; returned oldest first. */
function boundedWork(items: WorkItem[]): WorkItem[] {
  const perRoom = new Map<string, number>()
  const kept: WorkItem[] = []
  let bytes = 0

  // Newest first; notes written in the same millisecond keep the order they were written in.
  const newestFirst = items.map((item, index) => ({ item, index })).sort((a, b) => b.item.at - a.item.at || b.index - a.index)

  for (const { item } of newestFirst) {
    const count = perRoom.get(item.roomId) || 0
    const size = JSON.stringify(item).length

    if (count >= WORK_PER_ROOM || bytes + size > WORK_MAX_BYTES) {
      continue
    }

    perRoom.set(item.roomId, count + 1)
    bytes += size
    kept.push(item)
  }

  return kept.reverse()
}

function workEnvelope(items: WorkItem[]) {
  return {
    version: 1,
    updatedAt: Date.now(),
    items: items.map(item => ({ id: item.id, roomId: item.roomId, member: item.member, at: item.at, text: item.text }))
  }
}

function cleanWorkItem(raw: unknown): WorkItem | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const item = raw as Record<string, unknown>

  if (typeof item.id !== 'string' || typeof item.roomId !== 'string' || typeof item.member !== 'string' || typeof item.at !== 'number' || typeof item.text !== 'string') {
    return null
  }

  return { id: item.id.slice(0, 64), roomId: item.roomId.slice(0, 64), member: item.member.slice(0, 128), at: item.at, text: item.text.slice(0, WORK_TEXT) }
}

/** A bot worked something out loud in a group: keep it in Work. Teammates it names are woken by the caller. */
function recordWork(key: string, member: string, text: string) {
  const room = $rooms.get()[key]
  const body = text.trim().slice(0, WORK_TEXT)

  if (!room || !body) {
    return
  }

  $roomWork.set(boundedWork([...$roomWork.get(), { id: newId('w'), roomId: room.roomId, member, at: Date.now(), text: body }]))
  scheduleWorkSave()
}

/** Work notes that name this bot and were written since its last turn in the group. */
function workNotesFor(roomId: string, bot: Bot, since: number) {
  return $roomWork
    .get()
    .filter(item => item.roomId === roomId && item.member !== bot.name && item.at > since && mentionedIn(ownWords(item.text), [bot]).length > 0)
    .slice(-5)
}

let workTimer: null | ReturnType<typeof setTimeout> = null
let workSaving = false

function scheduleWorkSave() {
  if (workTimer) {
    clearTimeout(workTimer)
  }

  workTimer = setTimeout(() => {
    workTimer = null
    workSaving = true
    void saveWork()
      .catch(error => console.warn('work sync failed', error))
      .finally(() => {
        workSaving = false
      })
  }, 1200)
}

export async function saveWork() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = defaultRow()

    if (!row) {
      return
    }

    const envelope = workEnvelope(boundedWork($roomWork.get()))
    const revision = row.ui_meta_revisions?.[WORK_KEY]
    const result = await gateway.request<any>('profiles.configure', {
      name: row.name,
      profile: row.name,
      ui_meta: { [WORK_KEY]: envelope },
      ...(typeof revision === 'number' ? { ui_meta_expected_revisions: { [WORK_KEY]: revision } } : {})
    })

    if (result?.applied?.ui_meta_conflicts && Object.keys(result.applied.ui_meta_conflicts).length) {
      // Another writer saved work first: take theirs in, keep ours, and try again.
      await refreshProfiles()
      loadWork(true)
      continue
    }

    const revisions = result?.applied?.ui_meta_revisions || {}
    $profiles.set(
      $profiles.get().map(entry =>
        entry.name === row.name
          ? {
              ...entry,
              ui_meta: { ...(entry.ui_meta || {}), [WORK_KEY]: envelope },
              ui_meta_revisions: { ...(entry.ui_meta_revisions || {}), ...revisions }
            }
          : entry
      )
    )

    return
  }
}

/** Takes the synced work notes in, keeping any this device has not synced yet. */
function loadWork(force = false) {
  if (!force && (workTimer || workSaving)) {
    return
  }

  const raw = defaultRow()?.ui_meta?.[WORK_KEY] as { items?: unknown } | undefined

  if (!raw || !Array.isArray(raw.items)) {
    return
  }

  const merged = new Map<string, WorkItem>()

  for (const item of [...raw.items.map(cleanWorkItem), ...$roomWork.get()]) {
    if (item) {
      merged.set(item.id, item)
    }
  }

  const next = boundedWork([...merged.values()])

  // Same notes as before: leave the store alone so the panes don't re-render on every pass.
  if (JSON.stringify(next) !== JSON.stringify($roomWork.get())) {
    $roomWork.set(next)
  }
}

function putRoom(room: Room, sync = true) {
  $rooms.set({ ...$rooms.get(), [room.key]: room })
  saveLocalLog(room)

  if (sync) {
    scheduleSave()
  }
}

// ── room management ───────────────────────────────────────────────────────
export function createRoom(name: string, members: string[], settings?: RoomSettings): Room {
  const taken = new Set(Object.values($rooms.get()).map(room => room.name.toLowerCase()))
  let finalName = name.trim() || 'New group'
  let n = 2

  while (taken.has(finalName.toLowerCase())) {
    finalName = `${name.trim() || 'New group'} ${n++}`
  }

  const roomId = newId('room')
  const room: Room = {
    key: `id:${roomId}`,
    name: finalName,
    roomId,
    members: members.map(member => ({ name: member, handle: member === 'default' ? 'hermes' : member })),
    log: [],
    revision: 1,
    settings: cleanSettings(settings)
  }

  putRoom(room)

  return room
}

export function renameRoom(key: string, name: string) {
  const room = $rooms.get()[key]

  if (room && name.trim()) {
    putRoom({ ...room, name: name.trim(), revision: (room.revision || 0) + 1 })
  }
}

export function setRoomMembers(key: string, members: string[]) {
  const room = $rooms.get()[key]

  if (room) {
    putRoom({
      ...room,
      members: members.map(member => ({ name: member, handle: member === 'default' ? 'hermes' : member })),
      revision: (room.revision || 0) + 1
    })
  }
}

export function setRoomSettings(key: string, settings: RoomSettings) {
  const room = $rooms.get()[key]

  if (room) {
    putRoom({ ...room, settings: cleanSettings(settings), revision: (room.revision || 0) + 1 })
  }
}

/** A quiet member stays in the group and sees everything, but only speaks when @mentioned. */
export function setQuiet(key: string, member: string, quiet: boolean) {
  const room = $rooms.get()[key]

  if (!room) {
    return
  }

  const rest = (room.quiet || []).filter(name => name !== member)
  putRoom({ ...room, quiet: quiet ? [...rest, member] : rest, revision: (room.revision || 0) + 1 })
}

export function deleteRoom(key: string) {
  void stopRoom(key)
  const next = { ...$rooms.get() }
  delete next[key]
  deleted[key] = Date.now()
  $rooms.set(next)
  scheduleSave()
}

export function clearRoom(key: string) {
  const room = $rooms.get()[key]

  if (room) {
    putRoom({ ...room, log: [] })

    try {
      localStorage.removeItem(`room-log:${room.roomId}`)
    } catch {
      /* fine */
    }
  }
}

// ── who speaks ────────────────────────────────────────────────────────────
export function roomBots(room: Room): Bot[] {
  const bots = $allBots.get()

  return room.members.map(member => bots.find(bot => bot.name === member.name)).filter(Boolean) as Bot[]
}

function mentionForms(bot: Bot): string[] {
  return [bot.handle, bot.name, bot.display, bot.display.replace(/\s+/g, '')].map(v => v.toLowerCase()).filter(Boolean)
}

export function mentionedIn(text: string, bots: Bot[]): Bot[] {
  const lower = ` ${text.toLowerCase()} `

  if (/@(everyone|all|team)\b/.test(lower)) {
    return bots
  }

  // In the order they are named, so a multi-mention wakes them one at a time in that order.
  const firstAt = (bot: Bot) => {
    let best = -1

    for (const form of mentionForms(bot)) {
      let index = lower.indexOf(`@${form}`)

      while (index >= 0) {
        if (!/[a-z0-9_-]/.test(lower.charAt(index + form.length + 1))) {
          if (best < 0 || index < best) {
            best = index
          }

          break
        }

        index = lower.indexOf(`@${form}`, index + 1)
      }
    }

    return best
  }

  return bots
    .map(bot => ({ bot, at: firstAt(bot) }))
    .filter(item => item.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(item => item.bot)
}

function isEveryoneMention(text: string): boolean {
  return /@(everyone|all|team)\b/i.test(` ${text} `)
}

const STOP_WORDS = new Set(['stop', 'halt', 'pause'])

/** Where a stop/halt/pause word sits relative to any @mention: 'adjacent'
 *  within two tokens of one (a genuine "@bot stop"), 'distant' when the
 *  message has a stop word but none close to a mention, null without one. */
function stopWordPlacement(text: string): 'adjacent' | 'distant' | null {
  const tokens = text.toLowerCase().match(/@[a-z0-9._-]+|[a-z0-9_-]+/gi) || []
  const mentionAt: number[] = []
  const stopAt: number[] = []

  tokens.forEach((token, index) => {
    if (token.startsWith('@')) {
      mentionAt.push(index)
    } else if (STOP_WORDS.has(token)) {
      stopAt.push(index)
    }
  })

  if (stopAt.some(stop => mentionAt.some(at => Math.abs(stop - at) <= 2))) {
    return 'adjacent'
  }

  return stopAt.length ? 'distant' : null
}

/** "@bot stop" holds that bot; "@all stop" holds everyone; a plain, non-stop
 *  mention (or @all) releases whoever it addresses — mentioning a paused bot
 *  is how you wake it back up. Keeps a room's holds sticky across turns. */
function applyHoldDirective(prior: Record<string, number> | undefined, text: string, mentioned: Bot[], everyone: boolean, allMembers: string[]): Record<string, number> {
  const base = prior || {}
  const placement = stopWordPlacement(text)

  if (placement === null && everyone) {
    return Object.keys(base).length ? {} : base
  }

  const names = placement === 'adjacent' ? (everyone ? allMembers : mentioned.map(bot => bot.name)) : []
  const release = placement === null ? mentioned.map(bot => bot.name) : []

  if (!names.length && !release.length) {
    return base
  }

  const next = { ...base }
  let changed = false

  for (const name of names) {
    if (!next[name]) {
      next[name] = Date.now()
      changed = true
    }
  }

  for (const name of release) {
    if (next[name]) {
      delete next[name]
      changed = true
    }
  }

  return changed ? next : base
}

/** Who a "@bot stop" / "@all stop" in this message is aimed at. */
function stopTargets(text: string, mentioned: Bot[], everyone: boolean, allMembers: string[]): string[] {
  if (stopWordPlacement(text) !== 'adjacent') {
    return []
  }

  return everyone ? allMembers : mentioned.map(bot => bot.name)
}

/** Manually resume one held bot, or everyone — the "mention a paused bot or
 *  @all resume" hint, as a button. */
export function releaseHold(key: string, member?: string) {
  const room = $rooms.get()[key]

  if (!room?.holds || !Object.keys(room.holds).length) {
    return
  }

  if (!member) {
    putRoom({ ...room, holds: {} })

    return
  }

  if (room.holds[member]) {
    const holds = { ...room.holds }
    delete holds[member]
    putRoom({ ...room, holds })
  }
}

function watermarkKey(room: Room, member: string) {
  return `room-seen:${room.roomId}:${member}`
}

function seenCount(room: Room, member: string): number {
  try {
    return Number(localStorage.getItem(watermarkKey(room, member)) || 0)
  } catch {
    return 0
  }
}

function setSeen(room: Room, member: string, count: number) {
  try {
    localStorage.setItem(watermarkKey(room, member), String(count))
  } catch {
    /* fine */
  }
}

/** Reactions read from synced data: string → string, short emoji, at most 32 reactors. */
function cleanFiles(raw: any[]): BotFile[] {
  return raw
    .filter(f => f && typeof f.path === 'string' && typeof f.name === 'string')
    .slice(0, 4)
    .map(f => ({ path: String(f.path).slice(0, 1000), name: String(f.name).slice(0, 180), ...(typeof f.size === 'number' ? { size: f.size } : {}), ...(f.mime ? { mime: String(f.mime).slice(0, 100) } : {}) }))
}

function cleanReactions(raw: any): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw || {})
      .filter(([who, emoji]) => typeof emoji === 'string' && emoji.length <= 16 && who.length <= 128)
      .slice(0, 32)
  ) as Record<string, string>
}

function speakerLabel(entry: RoomEntry): string {
  if (entry.from.kind === 'user') {
    return `${entry.from.name || 'User'} (the user)`
  }

  const bot = $allBots.get().find(b => b.name === entry.from.name)
  const label = bot ? `${bot.display} (@${bot.handle})` : entry.from.name

  return entry.via === 'dm' ? `${label}, posted from their 1:1 chat` : label
}

/** Why a member is being woken, which decides how its prompt reads. */
type Why = 'asked' | 'handoff' | 'lead' | 'room'

interface Wake {
  name: string
  why: Why
}

const WHY_LINE: Record<Why, string> = {
  asked: 'You were addressed directly — answer.',
  handoff: 'A teammate just handed this to you — pick it up.',
  lead: 'Nobody was named. You are the Lead: answer first, decide who on the team should help, and hand work over by @mentioning them.',
  room: "Nobody was addressed by name. Speak only if you can add something the others haven't already covered. If another member already answered it, or it isn't for you, reply exactly: (pass)"
}

function buildPrompt(room: Room, bot: Bot, fresh: RoomEntry[], why: Why, marks: Record<string, string[]> = {}, session = '', notes: WorkItem[] = []): string {
  const members = roomBots(room)
    .map(member => `${member.display} (@${member.handle}${member.lead ? ', Lead' : ''})`)
    .join(', ')

  // Each line carries the entry's short id ([g…]) so a bot can react to it with react_to_message.
  const lines = fresh
    .map(entry => `${speakerLabel(entry)} [${roomRef(entry.id)}]${entry.threadOf ? ` (in thread on ${roomRef(entry.threadOf)})` : ''}: ${[...(marks[entry.id] || []), entry.text, ...(entry.files || []).map(f => `(sent the file ${f.path})`)].filter(Boolean).join('\n')}`)
    .join('\n\n')
  const reactionNotes = session ? takeNotes(`room:${room.roomId}:${bot.name}`) : []
  const rules = roomSettings(room).instructions

  return [
    // Only this room's own members can be woken from here, so only they are offered as routes.
    session
      ? teamContext(session, { ...directoryInput(bot.name, 'group'), scope: 'group', groupMembers: room.members.map(member => member.name) })
      : '',
    `[Group chat "${room.name}". You are ${bot.display} (@${bot.handle}). Members: ${members}. The user is ${$userName.get()}.]`,
    WHY_LINE[why],
    bot.lead && why !== 'lead' ? 'As the Lead, hand work to a teammate by @mentioning them when they are better placed.' : '',
    rules ? `House rules from the user for this group: ${rules}` : '',
    'You share this room with the others and see everything said in it, but not anyone\'s private 1:1 chats. Reply with your message to the group only — no speaker prefix. Keep it conversational.',
    'This is a group chat, not a first meeting: never offer onboarding, a profile of the user, or /help tips here.',
    'Only speak when you add something new: an answer, a fact, a decision, or work you did. Don\'t repeat, agree with, or sum up what someone already said. @mention a teammate only when you want them to act next. If you have nothing to add, reply exactly: (pass)',
    // What you write while working is progress: it lands in the group's Work section, not the chat. Your reply is the answer.
    directoryInput(bot.name, 'group').appTools
      ? `If an intermediate step has to reach the group right now (a decision, a blocker, a question someone must answer), post it with ${GROUP_POST_TOOL} to the group "${room.name}", then keep going. Your reply when you finish is the answer, so don't repeat what you already posted. Otherwise, keep your working notes out of the chat: they go to Work on their own.`
      : 'Keep your working notes out of the chat: what you write while working goes to the group\'s Work section on its own. Your reply is the answer.',
    '\u0000',
    'New messages since your last turn:',
    lines || '(none)',
    notes.length ? `\nWork from teammates that names you (their progress, not group messages):\n${notes.map(note => `${note.member}: ${note.text}`).join('\n')}` : '',
    fresh.length && fresh[fresh.length - 1].threadOf
      ? `\nThe last message is a reply in the thread on ${roomRef(fresh[fresh.length - 1].threadOf as string)}; your reply goes into that thread.`
      : '',
    reactionNotes.length ? `\nReactions since your last turn:\n${reactionNotes.join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n')
    .replace('\u0000', '')
}

// ── running a round ───────────────────────────────────────────────────────
/** `<room key>|<member>` → the thread root the member is answering in this turn. */
const turnThread = new Map<string, string>()
/** `<room key>|<member>` → when the member's last turn in the room started: the Work notes after it are new to it. */
const workSince = new Map<string, number>()

/** The root to file an entry under: a reply's root, or the entry itself. */
export const rootOfEntry = (entry: RoomEntry) => entry.threadOf || entry.id

const queues = new Map<string, Wake[]>()
const running = new Set<string>()
/** The unaddressed member holding this room's speak slot. Mentions do not take it. */
const speaking = new Map<string, string>()
/** Bot handoffs spent on the current user-message chain. A direct user @mention does not spend it. */
const chainTurns = new Map<string, number>()
/** Members whose room turn is still running, including after their reply is already on screen. */
const activeTurns = new Set<string>()
/**
 * Members whose last turn in this room failed. A teammate's @mention doesn't wake them again: it
 * would fail the same way and post the same error (a model the provider rejects, say). The user's
 * next message in the room clears it, and the user's own @mention always wakes them.
 */
const failedLast = new Map<string, Set<string>>()

function noteOutcome(key: string, member: string, failed: boolean) {
  const set = failedLast.get(key) || new Set<string>()

  if (failed) set.add(member)
  else set.delete(member)
  failedLast.set(key, set)
}

/** Busy in any scope: a group turn in this room, or a 1:1 / external turn of the bot anywhere. */
function memberBusy(key: string, member: string) {
  return activeTurns.has(turnKey(key, member)) || $busy.get()[member] === true
}

/** A plain room message (nobody addressed) or a lead wake. These never call a bot that is already working. */
const isPlainWake = (wake: { why: Why }) => wake.why === 'room' || wake.why === 'lead'

const turnRuntime = new Map<string, string>()
/** Entry ids already delivered by a steer, so the next prompt does not repeat them. */
const steeredIds = new Map<string, Set<string>>()

const turnKey = (key: string, member: string) => `${key}|${member}`
const stoppedTurn = 'the room was stopped'
type TurnOwner = { cancelled: boolean; dispose: () => void; runtime?: string }
const turnOwners = new Map<string, TurnOwner>()

function rankOf(bots: Bot[], name: string) {
  const bot = bots.find(item => item.name === name)

  if (bot?.lead) {
    return -1
  }

  const at = bots.findIndex(item => item.name === name)

  return at < 0 ? 999 : at
}

/** A `(pass)` is a control token, not a reply — never worth publishing, fragment or not. */
function pendingPass(text: string) {
  const t = text.trim().toLowerCase().replace(/\.+$/, '')

  return ['', 'p', 'pa', 'pas', 'pass', '(', '(p', '(pa', '(pas', '(pass', '(pass)', '[', '[pass', '[pass]'].includes(t) || PASS.test(text.trim())
}

// A pass is a control token, not a reply. Two shapes must never render: an assistant segment that
// is only a pass (caught by the shared PASS matcher), and a pass marker tucked onto a longer reply.
export function replyText(messages: ChatMsg[], display: string) {
  return stripOnboarding(messages
    .filter(msg => msg.role === 'assistant')
    .map(msg => msg.text.trim())
    .filter(Boolean)
    .filter(text => !PASS.test(text))
    .join('\n\n')
    .replace(/\s*[(\[]\s*pass\s*[)\]]?\s*\.?\s*$/i, '')
    .replace(/^\s*(?:\*\*)?[^:\n]{1,40}(?:\*\*)?:\s+(?=\S)/, match => (match.toLowerCase().includes(display.toLowerCase()) ? '' : match)))
}

/**
 * Hermes adds a one-time first-contact note to a profile's very first turn ("Type /help for
 * commands", offer to build a short profile of the user). When that first turn is a group turn the
 * offer leaked into the room. The prompt tells the bot not to, and any paragraph that still carries
 * it is dropped from the group copy.
 */
const ONBOARDING_LEAK = /\/help for (?:a list of )?commands|\bshort profile\b|build (?:a|your) (?:short )?profile (?:of|about) you/i

export function stripOnboarding(text: string) {
  if (!ONBOARDING_LEAK.test(text)) return text

  return text
    .split(/\n{2,}/)
    .filter(part => !ONBOARDING_LEAK.test(part))
    .join('\n\n')
    .trim()
}

function hasTypingMember(turns: Record<string, RoomTypingTurn> | undefined, member: string) {
  return Boolean(turns && Object.prototype.hasOwnProperty.call(turns, member) && turns[member])
}

function setTyping(key: string, member: string, messages: ChatMsg[] | null) {
  const all = $roomTyping.get()
  const turns = safeRecord(all[key])

  if (messages) {
    const thread = turnThread.get(`${key}|${member}`)
    turns[member] = { member, messages, ...(thread ? { thread } : {}) }
  } else {
    delete turns[member]
  }

  const next = safeRecord(all)

  if (Object.keys(turns).length) {
    next[key] = turns
  } else {
    delete next[key]
  }

  $roomTyping.set(next)
}

function enqueue(key: string, wakes: Wake[]) {
  const owned = $rooms.get()[key]

  // Another process owns this group's turns: its runner (or this app) answers the wakes, not this one.
  if (owned && !ownsTurns(owned)) {
    return
  }

  const queue = queues.get(key) || []

  for (const wake of wakes) {
    if (wake.why === 'handoff' && failedLast.get(key)?.has(wake.name)) {
      continue
    }

    const queued = queue.find(item => item.name === wake.name)

    if (!queued) {
      queue.push(wake)
    } else if (wake.why === 'asked' || wake.why === 'handoff') {
      queued.why = wake.why
    }
  }

  queues.set(key, queue)
}

/** Interrupts these members: drops them from the line and aborts whoever is mid-turn. */
async function interruptMembers(key: string, names: string[]) {
  if (!names.length) {
    return
  }

  queues.set(key, (queues.get(key) || []).filter(wake => !names.includes(wake.name)))
  const room = $rooms.get()[key]

  for (const name of names) {
    const runtime = turnRuntime.get(turnKey(key, name)) || (room ? runtimeFor(`room:${room.roomId}:${name}`) : '')

    if (runtime) {
      await gateway.request('session.interrupt', { session_id: runtime, profile: name }).catch(() => undefined)
    }

    if (speaking.get(key) === name) {
      speaking.delete(key)
      queueMicrotask(() => {
        if (!running.has(key)) {
          void drain(key)
        }
      })
    }
  }
}

/** Files waiting for the members who haven't read the message they came with yet. */
const sentFiles = new Map<string, Pending[]>()

async function pendingFor(room: Room, entry: RoomEntry): Promise<Pending[]> {
  const live = sentFiles.get(entry.id)

  if (live) {
    return live
  }

  const out: Pending[] = []

  for (const att of entry.attachments || []) {
    const blob = await blobOf(`room:${room.roomId}|${att.id}`)

    if (blob) {
      const mime = att.mime || blob.type || 'application/octet-stream'
      out.push({ id: att.id, file: new File([blob], att.name, { type: mime }), kind: att.kind, name: att.name, mime, size: blob.size, thumb: att.thumb })
    }
  }

  return out
}

export interface PostOptions {
  /** Answering a question card: only the bot that asked is woken. */
  answerTo?: string
  /** A reply in a thread: the root entry's id. */
  threadOf?: string
}

/** Who a user message wakes, and the holds it leaves on the room. Shared by a message the app posts
 * (postToRoom) and one the runner picks up from the synced room (pickUpMessage), so both answer by
 * the same rules. It changes nothing: the caller stores the holds and wakes the members. */
function planUserMessage(room: Room, body: string, opts: PostOptions) {
  const settings = roomSettings(room)
  const bots = roomBots(room)
  const names = bots.map(bot => bot.name)
  const mentioned = mentionedIn(body, bots)
  const everyone = isEveryoneMention(body)
  const quiet = new Set(room.quiet || [])

  // "@bot stop": by default only interrupts that turn (the bot answers the next message that
  // warrants it, like Grok Bot); in 'sticky' mode it stays paused until @mentioned again.
  const stopped = stopTargets(body, mentioned, everyone, names)
  let holds = room.holds

  if (settings.stop === 'sticky') {
    holds = applyHoldDirective(room.holds, body, mentioned, everyone, names)
  } else if (holds && Object.keys(holds).length) {
    holds = undefined
  }

  const held = new Set(Object.keys(holds || {}))
  const blocked = new Set([...held, ...stopped])
  const lead = bots.find(bot => bot.lead)
  let wakes: Wake[]

  if (stopped.length) {
    // A stop isn't a question: only someone else it names gets woken.
    wakes = mentioned.filter(bot => !blocked.has(bot.name)).map(bot => ({ name: bot.name, why: 'asked' as const }))
  } else if (everyone) {
    wakes = bots.filter(bot => !blocked.has(bot.name)).map(bot => ({ name: bot.name, why: 'asked' as const }))
  } else if (mentioned.length) {
    wakes = mentioned.filter(bot => !blocked.has(bot.name)).map(bot => ({ name: bot.name, why: 'asked' as const }))
  } else if (settings.reply === 'everyone') {
    wakes = bots.filter(bot => !blocked.has(bot.name) && !quiet.has(bot.name)).map(bot => ({ name: bot.name, why: 'room' as const }))
  } else if (settings.reply === 'lead') {
    const first = lead && !blocked.has(lead.name) ? [lead] : lead ? [] : bots.filter(bot => !blocked.has(bot.name) && !quiet.has(bot.name))
    wakes = first.map(bot => ({ name: bot.name, why: 'lead' as const }))
  } else {
    wakes = []
  }

  // A thread reply nobody was @mentioned in goes to the bot that wrote the root (if a bot did).
  const rootEntry = opts.threadOf ? room.log.find(e => e.id === opts.threadOf) : undefined

  if (rootEntry && !mentioned.length && !everyone && !stopped.length && rootEntry.from.kind === 'member' && names.includes(rootEntry.from.name) && !blocked.has(rootEntry.from.name)) {
    wakes = [{ name: rootEntry.from.name, why: 'asked' }]
  }

  // A reply is addressed to one member. `answerTo` is authoritative: it overrides any @mention in
  // the body, because the quoted text belongs to the quoted message and naming somebody in it was
  // never an instruction to wake them.
  if (opts.answerTo) {
    // A member who has since left the room must not silently widen into a room-wide wake — that is
    // the same class of bug as a reply target that is not a member.
    if (!names.includes(opts.answerTo)) {
      return { wakes: [], stopped, holds, misaddressed: true }
    }

    wakes = [{ name: opts.answerTo, why: 'asked' }]
  }

  // Highest role first, so the lead takes the unaddressed slot even if it was listed later.
  // A multi-mention keeps the order the user named them in.
  if (everyone || !mentioned.length || stopped.length || opts.answerTo) {
    wakes.sort((a, b) => rankOf(bots, a.name) - rankOf(bots, b.name))
  }

  return { wakes, stopped, holds, misaddressed: false }
}

/** Starts the wakes for a user message: a fresh chain, the stop itself, then the members. */
function wakeFor(key: string, plan: { wakes: Wake[]; stopped: string[] }) {
  // A user message opens a fresh chain. A bot still tooling must not block the idle
  // members from reading it. Direct @mentions do not spend the cap.
  speaking.delete(key)
  chainTurns.set(key, 0)

  // The stop itself: aborts whoever it names, right now.
  void interruptMembers(key, plan.stopped)
  enqueue(key, plan.wakes)
  void drain(key)
}

export function postToRoom(key: string, text: string, attachments: Pending[] = [], opts: PostOptions = {}) {
  const found = $rooms.get()[key]
  const body = text.trim()

  if (!found || (!body && !attachments.length)) {
    return
  }

  // Any question card still open goes unanswered (an answer marks its card before posting).
  const room = found.log.some(e => e.ask?.status === 'open')
    ? { ...found, log: found.log.map(e => (e.ask?.status === 'open' ? { ...e, ask: { ...e.ask, status: 'dismissed' as const } } : e)) }
    : found

  const plan = planUserMessage(room, body, opts)

  const entry: RoomEntry = {
    id: newId('g'),
    at: Date.now(),
    from: { kind: 'user', name: $userName.get() },
    text: body,
    ...(attachments.length ? { attachments: attachments.map(toMsgAttachment) } : {}),
    ...(opts.threadOf ? { threadOf: opts.threadOf } : {})
  }

  if (attachments.length) {
    sentFiles.set(entry.id, attachments)
    void rememberAttachments(`room:${room.roomId}`, attachments)
  }

  // A new message from the user gives members that failed last time another go.
  failedLast.delete(key)
  putRoom({ ...room, log: [...room.log, entry], holds: plan.holds })

  if (plan.misaddressed) {
    putRoom(
      {
        ...room,
        log: [...room.log, { id: newId('g'), at: Date.now(), from: { kind: 'user', name: $userName.get() }, text: `⚠️ ${opts.answerTo} isn't in this group, so nobody was asked to reply.` }]
      },
      false
    )

    return
  }

  wakeFor(key, plan)
}

/** The runner's side of a message the app posted. The entry is already in the synced log, so nothing
 * is appended; the same wakes run. Only for a group this process owns. */
export function pickUpMessage(key: string, entry: RoomEntry) {
  const room = $rooms.get()[key]
  const body = entry.text.trim()

  if (!room || !ownsTurns(room) || entry.from.kind !== 'user' || !body) {
    return
  }

  const plan = planUserMessage(room, body, { threadOf: entry.threadOf })

  // A new message from the user gives members that failed last time another go.
  failedLast.delete(key)

  if (JSON.stringify(plan.holds || null) !== JSON.stringify(room.holds || null)) {
    putRoom({ ...room, holds: plan.holds })
  }

  wakeFor(key, plan)
}

// ── posts from a bot's 1:1 chat (the group tool) ──────────────────────────
/** Recent group-tool posts, for the rate limits below. */
const toolPosts: { member: string; key: string; at: number }[] = []
const POSTS_PER_BOT_PER_MINUTE = 3
const POSTS_PER_ROOM_PER_10_MIN = 8
const MAX_POST_CHARS = 8000

/** The groups this bot belongs to. */
export function groupsOf(member: string): Room[] {
  return Object.values($rooms.get())
    .filter(room => room.members.some(m => m.name === member))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function groupList(member: string): string {
  const rooms = groupsOf(member)

  return rooms.length ? rooms.map(room => `"${room.name}"`).join(', ') : 'none (the user has not added you to a group)'
}

/**
 * A bot posts into one of its groups from its 1:1 chat. The message lands as that bot's and the
 * room runs as if it had spoken there: teammates it @mentions are woken (unless the user paused
 * them), and the room's turn cap applies. A bot mid-turn in any group can't use it, so a room
 * can't wake itself and two groups can't ping-pong.
 */
export function postFromBot(member: string, group: string, text: string, replyTo = ''): { ok: boolean; text: string } {
  const bot = $allBots.get().find(b => b.name === member)
  const body = String(text || '').trim()
  const wanted = groupKey(group)

  if (!bot) {
    return { ok: false, text: 'This bot is not in the NexurBots app.' }
  }

  if (!body) {
    return { ok: false, text: 'Nothing to post: text is empty.' }
  }

  if (body.length > MAX_POST_CHARS) {
    return { ok: false, text: `That message is too long for a group post (${body.length} characters, the limit is ${MAX_POST_CHARS}). Shorten it, or put the details in a file in the shared folder and link it.` }
  }

  const all = Object.values($rooms.get())
  const matches = all.filter(room => room.name.trim().toLowerCase() === wanted || room.roomId === group)

  if (!matches.length) {
    return { ok: false, text: `There is no group called "${group}". Your groups: ${groupList(member)}.` }
  }

  const room = matches.find(r => r.members.some(m => m.name === member))

  if (!room) {
    return { ok: false, text: `You are not a member of "${matches[0].name}", so you can't post there. Your groups: ${groupList(member)}.` }
  }

  if (matches.filter(r => r.members.some(m => m.name === member)).length > 1) {
    return { ok: false, text: `More than one of your groups is called "${room.name}". Ask the user to rename one.` }
  }

  const typing = $roomTyping.get()
  const busyIn = Object.entries(typing).find(([, members]) => hasTypingMember(members, member))
  // From its own turn in this group, a bot may post an intermediate step. Its answer still posts when the turn ends.
  const midTurnHere = busyIn?.[0] === room.key

  if (busyIn && !midTurnHere) {
    const where = $rooms.get()[busyIn[0]]

    return { ok: false, text: `You are taking a turn in "${where?.name || 'another group'}" right now. Group posts only work from your 1:1 chat; @mention teammates in your reply instead.` }
  }

  if (room.holds?.[member]) {
    return { ok: false, text: `The user paused you in "${room.name}". You can post there again after they @mention you in that group.` }
  }

  const now = Date.now()

  while (toolPosts.length && now - toolPosts[0].at > 10 * 60_000) {
    toolPosts.shift()
  }

  if (toolPosts.filter(post => post.member === member && now - post.at < 60_000).length >= POSTS_PER_BOT_PER_MINUTE) {
    return { ok: false, text: 'You have posted to groups several times in the last minute. Wait a moment before posting again.' }
  }

  if (toolPosts.filter(post => post.key === room.key).length >= POSTS_PER_ROOM_PER_10_MIN) {
    return { ok: false, text: `"${room.name}" has had a lot of posts from 1:1 chats in the last few minutes. Wait for the group to settle before posting again.` }
  }

  let threadOf: string | undefined

  if (replyTo) {
    const target = room.log.find(e => roomRef(e.id) === replyTo)

    if (!target) {
      return { ok: false, text: `There is no message ${replyTo} in "${room.name}". Use an id shown with a group message (g…).` }
    }

    threadOf = rootOfEntry(target)
  }

  toolPosts.push({ member, key: room.key, at: now })

  // A post from a 1:1 chat is marked as such; a step posted from the group's own turn is just the bot talking.
  const entry: RoomEntry = { id: newId('g'), at: now, from: { kind: 'member', name: member }, text: body, ...(midTurnHere ? {} : { via: 'dm' as const }), ...(threadOf ? { threadOf } : {}) }
  putRoom({ ...room, log: [...room.log, entry] })

  // Exactly what a bot's own reply does in the room: wake the teammates it @mentions, except
  // itself and anyone the user paused. The room's turn cap bounds the chain.
  const held = new Set(Object.keys(room.holds || {}))
  const others = roomBots(room).filter(other => other.name !== member && !held.has(other.name))
  const woken = mentionedIn(ownWords(body), others)
  enqueue(
    room.key,
    woken.map(other => ({ name: other.name, why: 'handoff' as const }))
  )
  void drain(room.key)

  const who = woken.map(other => `@${other.handle}`).join(', ')

  return {
    ok: true,
    text: woken.length
      ? `Posted in "${room.name}". ${who} will see it and answer there (the user can read the group).`
      : `Posted in "${room.name}". You didn't @mention anyone, so nobody is asked to reply.`
  }
}

/** A group name as a bot writes it ("#Launch", "“launch”"), compared case-insensitively. */
const groupKey = (group: string) =>
  String(group || '')
    .trim()
    .replace(/^#/, '')
    .replace(/^["'“]|["'”]$/g, '')
    .trim()
    .toLowerCase()

/** Same limit as the group name field in the app. */
const MAX_GROUP_NAME = 40

/**
 * `rename_group`: a bot renames one of its own groups (the tool tells it to only when the user asks).
 * The group gets a note saying who renamed it and from what.
 */
export function renameGroupFromBot(member: string, group: string, name: string): { ok: boolean; text: string } {
  const bot = $allBots.get().find(b => b.name === member)
  const next = String(name || '').trim().replace(/\s+/g, ' ')

  if (!bot) {
    return { ok: false, text: 'This bot is not in the NexurBots app.' }
  }

  if (!next) {
    return { ok: false, text: 'The new name is empty.' }
  }

  if (next.length > MAX_GROUP_NAME) {
    return { ok: false, text: `That name is too long (${next.length} characters, the limit is ${MAX_GROUP_NAME}).` }
  }

  const all = Object.values($rooms.get())
  const mine = all.filter(room => room.members.some(m => m.name === member) && (room.name.trim().toLowerCase() === groupKey(group) || room.roomId === group))

  if (!mine.length) {
    return { ok: false, text: `You are not in a group called "${group}". Your groups: ${groupList(member)}.` }
  }

  if (mine.length > 1) {
    return { ok: false, text: `More than one of your groups is called "${mine[0].name}". Ask the user which one to rename.` }
  }

  const room = mine[0]

  if (room.name === next) {
    return { ok: true, text: `The group is already called "${next}".` }
  }

  if (all.some(other => other.key !== room.key && other.name.trim().toLowerCase() === next.toLowerCase())) {
    return { ok: false, text: `There is already a group called "${next}". Pick another name.` }
  }

  const before = room.name
  renameRoom(room.key, next)
  addSwitchNote(`room:${room.roomId}`, `${bot.display} renamed the group from "${before}" to "${next}"`)

  return { ok: true, text: `Renamed "${before}" to "${next}".` }
}

/** `list_groups`: this bot's groups and who is in them. */
export function listGroupsText(member: string): string {
  const rooms = groupsOf(member)

  if (!rooms.length) {
    return 'You are not in any group chat yet. The user adds bots to groups in the app.'
  }

  return rooms
    .map(room => `"${room.name}": ${roomBots(room).map(bot => `${bot.display} (@${bot.handle})`).join(', ')}`)
    .join('\n')
}

function markRunning(key: string) {
  const busy = [...activeTurns].some(id => id.startsWith(`${key}|`)) || (queues.get(key) || []).length > 0 || speaking.has(key)
  $roomRunning.set({ ...$roomRunning.get(), [key]: busy })
}

function wakeFromReply(key: string, member: string, text: string) {
  const latest = $rooms.get()[key]

  if (!latest || !text || PASS.test(text)) {
    return
  }

  const held = new Set(Object.keys(latest.holds || {}))
  const others = roomBots(latest).filter(bot => bot.name !== member && !held.has(bot.name))
  enqueue(key, mentionedIn(ownWords(text), others).map(bot => ({ name: bot.name, why: 'handoff' as const })))
}

function releaseSpeak(key: string, member: string) {
  if (speaking.get(key) !== member) {
    return
  }

  speaking.delete(key)
  markRunning(key)
  queueMicrotask(() => {
    if (!running.has(key)) {
      void drain(key)
    }
  })
}

async function steerLive(key: string, member: string, entry: RoomEntry | undefined) {
  const runtime = turnRuntime.get(turnKey(key, member))
  const text = entry?.text?.trim() || ''
  const room = $rooms.get()[key]
  const files = room && entry?.attachments?.length ? await pendingFor(room, entry) : []
  const images = files.filter(item => item.kind === 'image')

  if (!runtime || !entry || (!text && !images.length)) {
    return false
  }

  // A failure is said in the room. It is never silently turned into "they'll read it later".
  const say = (line: string) => {
    const latest = $rooms.get()[key]

    if (latest) {
      putRoom({ ...latest, log: [...latest.log, { id: newId('g'), at: Date.now(), from: { kind: 'user', name: $userName.get() }, text: line }] }, false)
    }
  }

  let steered: { status?: string; delivery?: string } | null = null

  try {
    steered = images.length
      ? await gateway.request<{ status?: string; delivery?: string }>(
          'session.steer_media',
          { session_id: runtime, profile: member, text, images: await steerImages(images) },
          120_000
        )
      : await gateway.request<{ status?: string; delivery?: string }>('session.steer', { session_id: runtime, profile: member, text })
  } catch (error) {
    say(`⚠️ Correction not delivered to ${member}: ${String((error as Error)?.message || error)}`)

    return false
  }

  if (steered?.status === 'rejected') {
    // The turn ended in between: the member's next turn reads it as fresh input.
    return false
  }

  if (steered?.status !== 'queued' && steered?.status !== 'steered') {
    say(`⚠️ Correction not delivered to ${member}: Hermes answered ${steered?.status || 'nothing'}`)

    return false
  }

  if (steered.delivery === 'next_turn') {
    say(`⏳ ${member} is compressing its context; this correction is deferred to its next turn.`)
  }

  const seen = steeredIds.get(turnKey(key, member)) || new Set<string>()
  seen.add(entry.id)
  steeredIds.set(turnKey(key, member), seen)

  return true
}

async function drain(key: string) {
  if (running.has(key)) {
    return
  }

  const owned = $rooms.get()[key]

  if (owned && !ownsTurns(owned)) {
    return
  }

  running.add(key)
  markRunning(key)

  try {
    while (true) {
      const room = $rooms.get()[key]
      const queue = queues.get(key) || []

      if (!room || !queue.length) {
        break
      }

      const directAt = queue.findIndex(wake => wake.why === 'asked' || wake.why === 'handoff')

      if (directAt >= 0) {
        const wake = queue[directAt]
        const live = activeTurns.has(turnKey(key, wake.name))

        // Direct wakes (@mentions, @all, handoffs) go through the same speak slot as room-mode
        // wakes: one member at a time, in the order they were named. A wake for a member that is
        // already mid-turn still steers it right away. Otherwise it waits at the front of the
        // line until the current speaker releases the slot.
        if (!live && speaking.has(key)) {
          break
        }

        queue.splice(directAt, 1)
        queues.set(key, queue)

        if (wake.why === 'handoff') {
          const spent = chainTurns.get(key) || 0

          if (spent >= roomSettings(room).maxTurns) {
            continue
          }

          chainTurns.set(key, spent + 1)
        }

        if (live) {
          const entry = [...room.log].reverse().find(item => item.from.kind === 'user' || (item.from.kind === 'member' && item.from.name !== wake.name))
          void steerLive(key, wake.name, entry)
          continue
        }

        speaking.set(key, wake.name)
        void runMember(key, wake.name, wake.why)
        break
      }

      if (speaking.has(key)) {
        break
      }

      const spent = chainTurns.get(key) || 0

      if (spent >= roomSettings(room).maxTurns) {
        queues.set(key, [])
        break
      }

      queue.sort((a, b) => rankOf(roomBots(room), a.name) - rankOf(roomBots(room), b.name))
      // A plain room message never calls a bot that is already working, here or in its own 1:1 /
      // external chat. Those wakes are dropped, not replayed later: the message stays in the room
      // log, and that bot reads it on its next call.
      const skipped = queue.filter(wake => isPlainWake(wake) && memberBusy(key, wake.name))

      if (skipped.length) {
        queues.set(key, queue.filter(wake => !skipped.includes(wake)))
        continue
      }

      // A member is idle only when it has no group turn here AND no 1:1 or external turn anywhere.
      const idleAt = queue.findIndex(wake => !memberBusy(key, wake.name))

      // Everyone left is already in a turn. Leave them queued so they read this
      // message when they free up, instead of starting a second turn.
      if (idleAt < 0) {
        break
      }

      const wake = queue.splice(idleAt, 1)[0]
      queues.set(key, queue)
      chainTurns.set(key, spent + 1)
      speaking.set(key, wake.name)
      void runMember(key, wake.name, wake.why)
      break
    }
  } finally {
    running.delete(key)

    if (!(queues.get(key) || []).length && !speaking.has(key) && ![...activeTurns].some(id => id.startsWith(`${key}|`))) {
      chainTurns.set(key, 0)
    }

    markRunning(key)
  }
}

async function runMember(key: string, member: string, why: Why): Promise<null | string> {
  const room = $rooms.get()[key]
  const bot = $allBots.get().find(b => b.name === member)

  if (!room || !bot) {
    // A queued member the directory does not list cannot answer. Say so in the room rather than dropping the turn silently.
    if (room && !bot) {
      addSwitchNote(`room:${room.roomId}`, `${member} skipped: its profile is not loaded`)
    }

    releaseSpeak(key, member)
    return null
  }

  // A member on a machine that's offline sits this turn out; a line in the room says so (once a while).
  if (botOffline(member)) {
    const said = offlineSaid.get(`${key}|${member}`) || 0

    if (Date.now() - said > 10 * 60_000) {
      offlineSaid.set(`${key}|${member}`, Date.now())
      addSwitchNote(`room:${room.roomId}`, `${bot.display} skipped: ${machineLabel(hostOf(member))} is offline`)
    }

    releaseSpeak(key, member)
    return null
  }

  const seen = Math.min(seenCount(room, member), room.log.length)
  const delivered = steeredIds.get(turnKey(key, member))
  // Its own posts from its 1:1 chat count as new: this room session never saw them.
  const fresh = room.log.slice(seen).filter(entry => !(entry.from.kind === 'member' && entry.from.name === member && entry.via !== 'dm') && !delivered?.has(entry.id))
  const inThread = fresh.length ? fresh[fresh.length - 1].threadOf : undefined
  const otherLive = Object.values($roomTyping.get()[key] || {}).filter(turn => turn.member !== member)

  for (const live of otherLive) {
    const liveText = replyText(live.messages.filter(msg => !msg.interim), '')

    if (liveText && !pendingPass(liveText) && !fresh.some(entry => entry.from.kind === 'member' && entry.from.name === live.member && entry.text === liveText)) {
      fresh.push({ id: `live:${live.member}`, at: Date.now(), from: { kind: 'member', name: live.member }, text: liveText })
    }
  }

  // Teammates' Work notes that name this bot since its last turn here: the ask lives there, not in the log.
  const workKey = turnKey(key, member)
  const workNotes = workNotesFor(room.roomId, bot, workSince.get(workKey) || 0)
  workSince.set(workKey, Date.now())

  const promptAnchor = room.log[room.log.length - 1]?.id || ''
  const sessionKey = `room:${room.roomId}:${member}`

  if (inThread) {
    turnThread.set(`${key}|${member}`, inThread)
  } else {
    turnThread.delete(`${key}|${member}`)
  }

  const threaded = inThread ? { threadOf: inThread } : {}
  const handedOff = new Set<string>()
  // Work notes this turn has already kept, by message id.
  const workKept = new Set<string>()
  activeTurns.add(turnKey(key, member))
  const owner: TurnOwner = { cancelled: false, dispose: () => undefined }
  turnOwners.set(turnKey(key, member), owner)
  claimBusy(member, 'group')
  recordTurnStatus(member, fresh[fresh.length - 1]?.text || room.log[room.log.length - 1]?.text || '')
  setTyping(key, member, [])
  markRunning(key)

  const handoffNew = (text: string) => {
    const latest = $rooms.get()[key]

    if (!latest || !text || PASS.test(text)) {
      return
    }

    const held = new Set(Object.keys(latest.holds || {}))
    const others = roomBots(latest).filter(other => other.name !== member && !held.has(other.name))
    const next = mentionedIn(ownWords(text), others).filter(other => !handedOff.has(other.name))

    for (const other of next) {
      handedOff.add(other.name)
    }

    if (next.length) {
      enqueue(key, next.map(other => ({ name: other.name, why: 'handoff' as const })))
      queueMicrotask(() => {
        if (!running.has(key)) {
          void drain(key)
        }
      })
    }
  }

  // Text a bot sent before a tool call is progress: it goes to Work as soon as it is finished, and any
  // teammate it names is woken now, the same as an answer would wake them.
  const keepWork = (list: ChatMsg[]) => {
    for (const msg of list) {
      if (msg.role !== 'assistant' || !msg.interim || workKept.has(msg.id) || !msg.text.trim() || PASS.test(msg.text)) {
        continue
      }

      workKept.add(msg.id)
      recordWork(key, member, msg.text)
      handoffNew(msg.text)
    }
  }

  const rememberSeen = () => {
    const latest = $rooms.get()[key]

    if (!latest) {
      return
    }

    const at = promptAnchor ? latest.log.findIndex(entry => entry.id === promptAnchor) : -1

    if (at >= 0) {
      setSeen(latest, member, at + 1)
    }
  }

  try {
    let runtime = runtimeFor(sessionKey)

    if (!runtime) {
      runtime = (await resumeSession(sessionKey, member, { title: `Group: ${room.name}`, roomPlumbing: true }, true)).runtime
    }

    turnRuntime.set(turnKey(key, member), runtime as string)
    owner.runtime = runtime
    if (owner.cancelled || !$rooms.get()[key]) return null

    let messages: ChatMsg[] = []
    let settle: (error?: Error) => void = () => undefined

    // The link to Hermes can drop at any moment. While it is down the VM keeps working on the
    // turn — we just can't hear it — so the idle clock must pause instead of interrupting a
    // member we simply can't reach. When it comes back we resume the session and pull the answer
    // across, rather than erroring the whole room.
    const linkOpen = () => gateway.state.get() === 'open'

    // Ends on the turn's last event, or with an error if Hermes goes silent while the link stays
    // open, so one genuinely stuck member can't hang the whole room.
    const done = new Promise<void>((resolve, reject) => {
      let idle: ReturnType<typeof setTimeout> | undefined
      let stopListen: () => void = () => undefined
      let suspended = false
      let offReconnect: () => void = () => undefined
      let disposed = false

      const checkIdle = () => {
        if (disposed || owner.cancelled) return
        if (!linkOpen()) {
          // Link is down: hold the clock and re-check, never interrupt a member we can't hear.
          idle = setTimeout(checkIdle, 5_000)
          return
        }

        void gateway.request('session.interrupt', { session_id: runtime, profile: member }).catch(() => undefined)
        settle(new Error(`${bot.display} stopped responding, so the group moved on.`))
      }

      const arm = () => {
        if (disposed || owner.cancelled) return
        clearTimeout(idle)
        idle = setTimeout(checkIdle, turnIdleMs)
      }

      const onFrame = (event: GatewayEvent) => {
        if (disposed || owner.cancelled) return
        arm()
        messages = applyEvent(messages, event, member)
        setTyping(key, member, messages)
        keepWork(messages)

        if (isTurnEnd(event)) {
          noteTurnEnd(member)
          settle()
        }
      }

      const attach = (rt: string) => {
        if (disposed || owner.cancelled) return
        stopListen()
        stopListen = listen(rt, onFrame)
      }

      offReconnect = gateway.onReconnect(async () => {
        if (disposed || owner.cancelled || suspended) {
          return
        }

        suspended = true

        try {
          // Reconnect invalidates runtime sessions. Resume this one on the fresh socket and pull
          // back whatever the turn produced so far, so the answer is recovered, not lost.
          const fresh = await resumeSession(sessionKey, member, { title: `Group: ${room.name}`, roomPlumbing: true }, false)
          if (disposed || owner.cancelled || !$rooms.get()[key]) return
          runtime = fresh.runtime
          owner.runtime = runtime
          turnRuntime.set(turnKey(key, member), fresh.runtime)

          if (fresh.messages?.length) {
            messages = transcriptToMessages(fresh.messages)
          }

          attach(runtime)
          arm()
        } catch (error) {
          settle(error as Error)
        } finally {
          suspended = false
        }
      })

      settle = error => {
        if (disposed) return
        disposed = true
        clearTimeout(idle)
        stopListen()
        offReconnect()
        error ? reject(error) : resolve()
      }
      owner.dispose = () => {
        // A stopped turn still ended: keep the memory bookkeeping a terminal frame would have done.
        if (owner.cancelled && !disposed) noteTurnEnd(member)
        settle(owner.cancelled ? new Error(stoppedTurn) : undefined)
      }

      attach(runtime as string)
      arm()
    })
    // Stop can settle this during attachment I/O. Its owning await still handles the rejection.
    void done.catch(() => undefined)

    // Pictures and files that came with messages this member hasn't read yet go to its own session.
    const marks: Record<string, string[]> = {}

    for (const entry of fresh) {
      if (entry.attachments?.length) {
        const files = await pendingFor(room, entry)
        if (owner.cancelled || !$rooms.get()[key]) return null

        if (files.length) {
          marks[entry.id] = (await attachAll(runtime as string, member, files)).markers
          if (owner.cancelled || !$rooms.get()[key]) return null
        }
      }
    }

    try {
      if (owner.cancelled || !$rooms.get()[key]) return null
      await gateway.request('prompt.submit', { session_id: runtime, profile: member, text: buildPrompt(room, bot, fresh, why, marks, runtime as string, workNotes) }, 120_000)
    } catch (error) {
      settle()
      throw error
    }

    await done

    const latest = $rooms.get()[key]

    if (!latest) {
      return null
    }

    keepWork(messages)
    const errors = messages.filter(msg => msg.role === 'error')
    // The group gets the answer. Text Hermes marked interim (sent before a tool call) was progress, and it is in Work.
    const text = replyText(messages.filter(msg => !msg.interim), bot.display)
    noteOutcome(key, member, errors.length > 0)

    if (errors.length && !text) {
      const entry: RoomEntry = { id: newId('g'), at: Date.now(), from: { kind: 'member', name: member }, text: `⚠️ ${errors[0].text}`, ...threaded }
      putRoom({ ...latest, log: [...latest.log, entry] }, false)
      rememberSeen()
      return null
    }

    if (!text || PASS.test(text)) {
      rememberSeen()
      releaseSpeak(key, member)
      return null
    }

    const entry: RoomEntry = { id: newId('g'), at: Date.now(), from: { kind: 'member', name: member }, text, ...threaded }
    putRoom({ ...latest, log: [...latest.log, entry] })
    handoffNew(text)
    rememberSeen()
    releaseSpeak(key, member)
    return text
  } catch (error) {
    const latest = $rooms.get()[key]

    if (!owner.cancelled) noteOutcome(key, member, true)

    if (latest && !owner.cancelled) {
      putRoom(
        {
          ...latest,
          log: [...latest.log, { id: newId('g'), at: Date.now(), from: { kind: 'member', name: member }, text: `⚠️ ${(error as Error).message}` }]
        },
        false
      )
    }

    releaseSpeak(key, member)
    return null
  } finally {
    owner.dispose()
    if (turnOwners.get(turnKey(key, member)) === owner) turnOwners.delete(turnKey(key, member))
    activeTurns.delete(turnKey(key, member))
    turnRuntime.delete(turnKey(key, member))
    releaseBusy(member, 'group')
    refreshExternalSoon()
    clearTurnStatus(member)
    releaseSpeak(key, member)

    setTyping(key, member, null)

    turnThread.delete(`${key}|${member}`)
    markRunning(key)
    queueMicrotask(() => {
      if (!running.has(key)) {
        void drain(key)
      }
    })
  }
}

// ── compressing a member's hidden history ──────────────────────────────────
/** Matches the gateway's own compute-host wait for a focused chat's
 *  /compress — the socket's usual 30s default would report a false timeout
 *  while the summary is still committing. */
const COMPRESS_TIMEOUT_MS = 660_000

export interface CompressOutcome {
  compressed: number
  pending: number
  skipped: number
  lines: string[]
}

/** Each room member gets its own hidden per-room session, and those grow
 *  forever — they're reachable from no other surface, so nothing else ever
 *  shrinks them. This is the room-settings "Compress history" action: resume
 *  each member's room session, then run the gateway's session.compress
 *  against its live runtime id. */
export async function compressRoomHistory(key: string): Promise<CompressOutcome> {
  const room = $rooms.get()[key]
  const outcome: CompressOutcome = { compressed: 0, pending: 0, skipped: 0, lines: [] }

  if (!room) {
    return outcome
  }

  for (const bot of roomBots(room)) {
    const sessionKey = `room:${room.roomId}:${bot.name}`

    try {
      let runtime = runtimeFor(sessionKey)

      if (!runtime) {
        runtime = (await resumeSession(sessionKey, bot.name, { title: `Group: ${room.name}`, roomPlumbing: true }, true)).runtime
      }

      const result = await gateway.request<{
        status?: string
        compressed?: boolean
        before_messages?: number
        after_messages?: number
        summary?: { aborted?: boolean; headline?: string }
      }>('session.compress', { session_id: runtime }, COMPRESS_TIMEOUT_MS)

      if (result?.status === 'pending') {
        outcome.pending++
      } else if (result?.status === 'aborted' || result?.summary?.aborted || result?.compressed === false) {
        outcome.skipped++
      } else {
        outcome.compressed++
        const headline =
          result?.summary?.headline ||
          (typeof result?.before_messages === 'number' && typeof result?.after_messages === 'number'
            ? `${bot.display}: ${result.before_messages} → ${result.after_messages} messages`
            : '')

        if (headline) {
          outcome.lines.push(headline)
        }
      }
    } catch {
      outcome.skipped++
    }
  }

  return outcome
}

export async function stopRoom(key: string) {
  queues.set(key, [])
  const interrupts: Promise<unknown>[] = []
  for (const [id, owner] of turnOwners) {
    if (!id.startsWith(`${key}|`) || owner.cancelled) continue
    owner.cancelled = true
    owner.dispose()
    if (owner.runtime) interrupts.push(gateway.request('session.interrupt', { session_id: owner.runtime, profile: id.slice(key.length + 1) }).catch(() => undefined))
  }
  await Promise.all(interrupts)
}

// ── reactions ───────────────────────────────────────────────────────────────
/** Toggle `reactor`'s reaction on one entry (same emoji removes it). Returns the entry, or null. */
export function reactInRoom(key: string, entryId: string, reactor: string, emoji: string): null | RoomEntry {
  const room = $rooms.get()[key]
  const index = room ? room.log.findIndex(entry => entry.id === entryId) : -1

  if (!room || index < 0) {
    return null
  }

  const entry = room.log[index]
  const next = { ...(entry.reactions || {}) }

  if (next[reactor] === emoji) {
    delete next[reactor]
  } else {
    next[reactor] = emoji
  }

  const updated = { ...entry, reactions: next }
  putRoom({ ...room, log: room.log.map((e, i) => (i === index ? updated : e)) })

  return updated
}

/** The entry a bot means by `[g…]`, in one of the groups it's a member of. */
export function roomEntryByRef(member: string, ref: string): null | { room: Room; entry: RoomEntry } {
  for (const room of groupsOf(member)) {
    const entry = room.log.find(e => roomRef(e.id) === ref)

    if (entry) {
      return { room, entry }
    }
  }

  return null
}

// ── question cards ──────────────────────────────────────────────────────────
/** The group this member is taking a turn in right now, if any (where its `ask_user` card goes). */
export function roomInTurn(member: string): null | Room {
  const typing = $roomTyping.get()
  const key = Object.keys(typing).find(k => hasTypingMember(typing[k], member))

  return key ? $rooms.get()[key] || null : null
}

export function isMemberTypingInRoom(member: string): boolean {
  return Object.values($roomTyping.get()).some(turns => hasTypingMember(turns, member))
}

/** Posts a member's question card into the group. */
export function addRoomAsk(key: string, member: string, card: AskCard, text: string) {
  const room = $rooms.get()[key]

  if (!room) {
    return
  }

  const log = room.log.map(e => (e.ask?.status === 'open' && e.from.name === member ? { ...e, ask: { ...e.ask, status: 'dismissed' as const } } : e))
  putRoom({ ...room, log: [...log, { id: card.id, at: card.at, from: { kind: 'member', name: member }, text, ask: card }] })
}

export function updateRoomAsk(key: string, entryId: string, patch: Partial<AskCard>) {
  const room = $rooms.get()[key]

  if (room) {
    putRoom({ ...room, log: room.log.map(e => (e.id === entryId && e.ask ? { ...e, ask: { ...e.ask, ...patch } } : e)) })
  }
}

/** A member asked for a secret during its group turn: the group only gets a pointer to the 1:1 chat. */
export function addRoomSecretNote(key: string, member: string, card: SecretCard) {
  const room = $rooms.get()[key]

  if (room) {
    const entry: RoomEntry = {
      id: newId('g'),
      at: card.at,
      from: { kind: 'member', name: member },
      text: `(Asked the user for ${card.name} in a private 1:1 card; the value is never shared here.)`,
      secretAsk: { name: card.name, label: card.label }
    }
    putRoom({ ...room, log: [...room.log, entry] })
  }
}

/** A member needs the user on its screen during a group turn: the group gets a pointer to the 1:1 card. */
export function addRoomHelpNote(key: string, member: string, card: HelpCard) {
  const room = $rooms.get()[key]

  if (room) {
    const entry: RoomEntry = {
      id: newId('g'),
      at: card.at,
      from: { kind: 'member', name: member },
      text: `(Handed my screen to the user in our 1:1 chat: ${card.instruction})`,
      helpAsk: { instruction: card.instruction }
    }
    putRoom({ ...room, log: [...room.log, entry] })
  }
}

/** A member sent a file during its group turn: an entry with the caption and the file reference. */
export function addRoomFilePost(key: string, member: string, post: { id: string; at: number; caption?: string; files: BotFile[] }) {
  const room = $rooms.get()[key]

  if (room) {
    const entry: RoomEntry = {
      id: newId('g'),
      at: post.at,
      from: { kind: 'member', name: member },
      // Other members read the caption plus which file it was.
      text: post.caption || '',
      files: post.files,
      ...(turnThread.get(`${key}|${member}`) ? { threadOf: turnThread.get(`${key}|${member}`) } : {})
    }
    putRoom({ ...room, log: [...room.log, entry] })
  }
}

/** `reply_in_thread` in a group: a reply under the entry `ref` points at (or under its root). */
export function replyInRoomThread(member: string, ref: string, text: string): { ok: boolean; text: string } {
  const found = roomEntryByRef(member, ref)

  if (!found) {
    return { ok: false, text: `There is no message ${ref} in your groups.` }
  }

  const root = rootOfEntry(found.entry)
  const entry: RoomEntry = { id: newId('g'), at: Date.now(), from: { kind: 'member', name: member }, text, threadOf: root }
  putRoom({ ...found.room, log: [...found.room.log, entry] })

  return { ok: true, text: `Replied in the thread on ${roomRef(root)} in "${found.room.name}".` }
}
