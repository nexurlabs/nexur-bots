export type AvatarShape = 'circle' | 'cloud' | 'drop' | 'hexagon' | 'pill' | 'squircle' | 'triangle'
export type FaceMood = 'idle' | 'think' | 'work'

export interface AvatarAppearance {
  color: null | string
  image: null | string
  shape: string
}

/** ui_meta['hermes-bots'] — shared with Hermes's own Bots plugin. */
export interface BotMeta {
  title?: string
  /** A short line the user sets under the bot's name ("Lead", "Researcher"); empty by default. */
  label?: string
  description?: string
  color?: string
  shape?: string
  custom?: boolean
  image?: null | string
  imageKind?: 'photo' | 'shape'
  hidden?: boolean
  pinned?: boolean
  lead?: boolean
  created?: number
  [key: string]: unknown
}

export interface SessionPreview {
  id: string
  resolved_id?: string
  title?: string
  preview?: string
  started_at?: number
  last_active?: number
  message_count?: number
}

export interface ProfileRow {
  name: string
  path?: string
  is_default?: boolean
  model?: null | string
  provider?: null | string
  description?: string
  display_name?: string
  skill_count?: number
  last_session?: null | SessionPreview
  canonical_session?: null | SessionPreview
  worker_session?: null | { id: string; last_active?: number }
  ui_meta?: null | Record<string, unknown>
  ui_meta_revisions?: Record<string, number>
  has_avatar?: boolean
}

export interface Bot {
  name: string
  row: ProfileRow
  meta: BotMeta
  display: string
  handle: string
  lead: boolean
  lastActive: number
  preview: string
}

export interface ToolCall {
  id: string
  name: string
  label: string
  done: boolean
  summary?: string
  error?: boolean
}

/** A file or picture that came with a message. `thumb` is a small preview data URL. */
export interface MsgAttachment {
  id: string
  kind: 'file' | 'image'
  name: string
  mime?: string
  size?: number
  thumb?: string
  /** The name Hermes stored it under (how a reloaded message finds its local copy). */
  ref?: string
}

/** One choice on a question card from a bot (`ask_user`). */
export interface AskOption {
  label: string
  value?: string
  description?: string
  style?: 'default' | 'primary' | 'danger'
}

/** A question a bot asked with clickable options. Open until answered, or dismissed by a typed message. */
export interface AskCard {
  id: string
  at: number
  prompt: string
  options: AskOption[]
  allowCustom?: boolean
  multi?: boolean
  status: 'open' | 'answered' | 'dismissed'
  /** Labels of the options picked. */
  picked?: string[]
  /** Text typed into the "other" box. */
  custom?: string
  /**
   * The bot that asked, recorded when the card is made. An answer goes back to this bot and not to
   * whichever chat happens to be on screen, so switching the visible DM cannot redirect an answer.
   * Absent on cards stored before this existed; those are read from the chat they live in.
   */
  owner?: string
}

/** A bot asked the user for a secret (`request_secret`). The value itself is never stored here. */
export interface SecretCard {
  id: string
  at: number
  /** The environment variable, e.g. OPENAI_API_KEY. */
  name: string
  label: string
  description?: string
  status: 'open' | 'saved' | 'cancelled'
  /** The bot that asked, so the value is saved and reported to it rather than to the visible chat. */
  owner?: string
}

/** A bot handed its screen to the user for a step only they can do (`request_user_help`). */
export interface HelpCard {
  id: string
  at: number
  instruction: string
  url?: string
  doneLabel: string
  status: 'open' | 'done' | 'failed'
  reason?: string
  /** The bot that asked, so the handoff opens for it and not for whichever chat is on screen. */
  owner?: string
}

/** A file a bot sent (`send_file`): a reference to it on the Hermes machine, fetched when needed. */
export interface BotFile {
  path: string
  name: string
  size?: number
  mime?: string
  /** A spoken reply (`send_voice_memo`): shown as a voice bubble, the post's caption is its text. */
  voice?: boolean
  /** Voice memos: length in seconds, when known. */
  seconds?: number
  /** The machine (host id) the file is on, when it isn't the main one. */
  host?: string
}

export interface ChatMsg {
  id: string
  role: 'assistant' | 'error' | 'system' | 'user'
  text: string
  at: number
  /** Group rooms: who said it (a bot name). */
  from?: string
  tools?: ToolCall[]
  streaming?: boolean
  /** Text the bot sent before a tool call: progress, not the final answer. */
  interim?: boolean
  /** The reply was cut off (Stop, or Hermes restarted mid-stream): the partial text is kept and marked. */
  stopped?: boolean
  attachments?: MsgAttachment[]
  /** Sent while the bot was mid-reply: folded into the running turn, or queued to run right after it. */
  midTurn?: 'steered' | 'queued'
  /** Typed while Hermes was unreachable: held on this device and sent once the connection is back. */
  waiting?: boolean
  /** A per-message thinking level the user picked for this message. */
  thinking?: string
  /** A routine's result Hermes delivered into this chat: the routine's name. */
  routine?: string
  /** Group rooms: the bot posted this from its 1:1 chat (the group tool). */
  via?: 'dm'
  /** A line from the app, not the bot: e.g. it changed its own name. Kept on this device. */
  note?: boolean
  /** 1:1 user messages: the id the bot sees for it (`Message id: u…` in the hidden context). */
  ref?: string
  /** Reactions on it: reactor (`user` or a bot's profile name) → emoji. */
  reactions?: Record<string, string>
  /** A question card from the bot (`ask_user`). */
  ask?: AskCard
  /** A secret-entry card from the bot (`request_secret`), 1:1 only. */
  secret?: SecretCard
  /** Groups: a bot asked for a secret; the input is in its 1:1 chat, never here. */
  secretAsk?: { name: string; label: string }
  /** A sign-in handoff card from the bot (`request_user_help`), 1:1 only. */
  help?: HelpCard
  /** Groups: a bot needs the user on its screen; the card is in its 1:1 chat. */
  helpAsk?: { instruction: string }
  /** Files the bot sent (`send_file`); `text` is the caption. */
  files?: BotFile[]
  /** A thread reply: its root's id. */
  thread?: string
  /** Set by the view: this message's own id as a thread root, and its replies so far. */
  threadId?: string
  replies?: { count: number; at: number; who: string[] }
}

export interface RoomMember {
  name: string
  handle?: string
}

/** Something a bot worked out loud in a group: progress before its answer, kept out of the group's log. */
export interface WorkItem {
  id: string
  roomId: string
  member: string
  at: number
  text: string
}

export interface RoomEntry {
  id: string
  at: number
  from: { kind: 'member' | 'user'; name: string }
  text: string
  thread?: string
  /** Files that came with a user message (kept on this device; other devices see only the text). */
  attachments?: MsgAttachment[]
  /** A bot posted this from its 1:1 chat with the group tool, not as a turn in the room. */
  via?: 'dm'
  /** Reactions: reactor (`user` or a bot's profile name) → emoji. `{}` once all are removed. */
  reactions?: Record<string, string>
  /** A question card the member asked (`ask_user`); `text` holds the question for the other bots. */
  ask?: AskCard
  /** The member asked for a secret; the card is in its 1:1 chat, never in the group. */
  secretAsk?: { name: string; label: string }
  /** The member needs the user on its screen; the card is in its 1:1 chat. */
  helpAsk?: { instruction: string }
  /** Files the member sent (`send_file`): references, fetched from Hermes when shown. */
  files?: BotFile[]
  /** A thread reply: the root entry's id. */
  threadOf?: string
}

/** Per-group behaviour. Grok Bot has none of these; every field is optional and falls back to how Grok Bot acts. */
export interface RoomSettings {
  /** Who is woken when a message @mentions nobody: every member (each may stay silent), only the Lead, or nobody. */
  reply?: 'everyone' | 'lead' | 'mentions'
  /** "@bot stop": interrupt just that turn ('turn'), or keep the bot paused until it is @mentioned again ('sticky'). */
  stop?: 'turn' | 'sticky'
  /** Most bot turns after one user message. 0 / unset = automatic. */
  maxTurns?: number
  /** Standing instructions every member sees. */
  instructions?: string
  /** The group's turns run on the VM runner, so they keep going with the app closed. Unset = this app runs them. */
  runner?: boolean
}

export interface Room {
  key: string
  name: string
  roomId: string
  members: RoomMember[]
  log: RoomEntry[]
  image?: string
  revision?: number
  /** Bots told to stop/pause in this room (name → when), until mentioned again or released. */
  holds?: Record<string, number>
  settings?: RoomSettings
  /** Members that only speak when @mentioned (names). */
  quiet?: string[]
}

/** Hermes's answers to an approval request (`approval` server request / `approval.respond`). */
export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

/** What kind of risky thing the bot wants to do, for the card's wording. */
export type ApprovalKind = 'command' | 'pc' | 'file' | 'tool'

/**
 * A risky action a bot asked to do. Pending, it shows as a card in the chat it came from; once
 * answered it collapses to a one-line record that stays in that chat.
 */
export interface Approval {
  /** The server request id (`srq-…`) Hermes asked with. */
  id: string
  /** Hermes's own id for the queued approval (`approval.respond` `request_id`). */
  requestId: string
  /** The runtime session that asked. */
  sessionId: string
  /** The bot (profile) that asked. */
  bot: string
  /** Where it shows: `bot:<name>` for a 1:1 chat, `room:<roomId>` for a group. */
  scope: string
  kind: ApprovalKind
  /** The command or action, as Hermes words it (secrets already redacted by Hermes). */
  command: string
  /** Hermes's reason, in plain words. */
  description: string
  choices: ApprovalChoice[]
  /** The untrusted MCP server that asked (Hermes asks on every call and keeps no grant for these). */
  server?: string
  /** This PC: the kind of action asked about (`click`, `type`, …); "Allow for this chat" covers only that. */
  action?: string
  /** Hermes's smart check flagged it; only a one-time allow is offered. */
  flagged?: boolean
  status: 'pending' | 'sending' | 'expired' | ApprovalChoice
  at: number
  endedAt?: number
  /** Why it ended without an answer from here ("Timed out", "Answered elsewhere", …), or why the app answered it ("control is off"). */
  note?: string
  /** Allowed by an earlier "Allow for this chat" without asking again. */
  auto?: boolean
}

export interface PendingPrompt {
  id: string
  method: string
  sessionId: string
  params: Record<string, any>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  /** Point the card's answer at a re-delivered request (after a reconnect), keeping one card. */
  rebind: (resolve: (value: unknown) => void, reject: (error: Error) => void) => void
}

export interface Connection {
  id: string
  kind: 'local' | 'remote' | 'ssh'
  label: string
  baseUrl?: string
  token?: string
  ssh?: { host: string; user?: string; port?: number; keyPath?: string; remoteHermesPath?: string }
  lastUsed?: number
}
