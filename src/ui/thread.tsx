/** Pieces shared by a bot's 1:1 chat and a group room. */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import {
  $library,
  downloadAttachment,
  humanSize,
  loadLibrary,
  makePending,
  MAX_ATTACHMENTS,
  readAsDataUrl,
  blobOf,
  type LibraryItem,
  type Pending
} from '../lib/attachments'
import { answerApproval, CHOICE_LABEL, KIND_ASK, pcNoun, RECORD_LABEL, shortAction } from '../lib/approvals'
import { compactInstruction } from '../lib/handoff'
import { $botConfig, isLoaded, REASONING_CHOICES, reasoningLabel } from '../lib/botconfig'
import { $prompts, type SendOptions } from '../lib/chat'
import { native } from '../lib/native'
import { isAskTool } from '../lib/ask'
import { fetchBotFile, kindOf, openBotFile, playable, saveBotFile } from '../lib/bot-files'
import { isReactTool, pills, QUICK_REACTIONS, USER } from '../lib/reactions'
import { findKey, NAME_RE } from '../lib/secrets'
import { showComputerTab } from '../lib/screen-chip'
import { $panelOpen, $selection, $userName, toast } from '../lib/store'
import type { Approval, ApprovalChoice, AskCard, Bot, BotFile, ChatMsg, HelpCard, SecretCard, MsgAttachment, PendingPrompt, ToolCall } from '../lib/types'
import { Avatar } from './avatar'
import { crewColor } from './colors'
import { openContextMenu } from './context-menu'
import { Icon } from './icons'
import { $lightbox } from '../lib/lightbox'
import { $jumpTo } from '../lib/search'
import { Markdown } from './markdown'
import { Menu } from './menu'

function copyMessage(text: string) {
  void native.copyText(text).then(ok => toast(ok ? 'Copied' : 'Could not copy', ok ? 'good' : 'bad'))
}

/**
 * The message the person is replying to; the composer quotes it when they send.
 *
 * `member` is the group member who wrote it, when the quote was picked in a group. A reply in a
 * group is addressed to that member and wakes only them, so the composer has to carry it through —
 * a quote alone is plain quoted text, which every bot in the room would be woken by.
 */
export const $quote = atom<{ who: string; text: string; member?: string; scope?: string } | null>(null)

const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat
}

/** The message whose emoji picker is open (one at a time). The demo sets it for screenshots. */
export const $reactPicker = atom<null | string>(null)

function ReactButton({ msg }: { msg: ChatMsg }) {
  const open = useStore($reactPicker) === msg.id

  return (
    <button
      aria-expanded={open}
      aria-label="React"
      className="icon-btn xs ghost"
      onClick={event => {
        event.stopPropagation()
        $reactPicker.set(open ? null : msg.id)
      }}
      title="React"
      type="button"
    >
      <Icon name="react" size={14} />
    </button>
  )
}

function ReactPicker({ msg, onReact }: { msg: ChatMsg; onReact: (msg: ChatMsg, emoji: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const mine = msg.reactions?.[USER]

  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !ref.current?.contains(event.target as Node) && !(event.target as Element)?.closest?.('.bubble-actions')) {
        $reactPicker.set(null)
      }
    }

    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close, true)

    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close, true)
    }
  }, [])

  return (
    <div className="react-picker" ref={ref} role="menu">
      {QUICK_REACTIONS.map(emoji => (
        <button
          aria-label={`React ${emoji}`}
          data-mine={mine === emoji || undefined}
          key={emoji}
          onClick={() => {
            onReact(msg, emoji)
            $reactPicker.set(null)
          }}
          role="menuitem"
          type="button"
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}

function Reactions({ msg, nameOf, onReact }: { msg: ChatMsg; nameOf: (who: string) => string; onReact?: (msg: ChatMsg, emoji: string) => void }) {
  const list = pills(msg.reactions)

  if (!list.length) {
    return null
  }

  return (
    <div className="reactions">
      {list.map(pill => {
        const mine = pill.who.includes(USER)
        const names = pill.who.map(nameOf).join(', ')

        return (
          <button
            aria-label={`${pill.emoji} from ${names}`}
            className="reaction"
            data-mine={mine || undefined}
            disabled={!onReact}
            key={pill.emoji}
            onClick={() => onReact?.(msg, pill.emoji)}
            title={`${names}${mine ? ' · click to remove yours' : ''}`}
            type="button"
          >
            <span>{pill.emoji}</span>
            {pill.who.length > 1 ? <small>{pill.who.length}</small> : null}
          </button>
        )
      })}
    </div>
  )
}

function HelpCardView({
  card,
  who,
  active,
  computerOff,
  onOpen,
  onFail
}: {
  card: HelpCard
  who: string
  /** The handoff is in progress (the screen was opened from this card). */
  active?: boolean
  /** The bot's computer is known to be off: the button starts it first. */
  computerOff?: boolean
  onOpen?: (card: HelpCard) => void
  onFail?: (card: HelpCard, reason: string) => void
}) {
  const [reason, setReason] = useState<null | string>(null)
  const open = card.status === 'open' && !!onOpen

  // Handed back or given up: one quiet line, not a box.
  if (!open) {
    return (
      <div className="help-line" data-status={card.status}>
        <Icon name="computer" size={13} />
        {`${who}'s computer: ${card.status === 'done' ? 'handed back' : `not done${card.reason ? ` (${card.reason})` : ''}`}`}
      </div>
    )
  }

  return (
    <div className="help-card" data-status={card.status}>
      <div className="help-head">
        <Icon name="computer" size={14} />
        <span>
          <b>{who} needs you on its computer</b> {compactInstruction(card.instruction)}
        </span>
      </div>
      {reason !== null ? (
        <div className="secret-actions">
          <input className="help-reason" onChange={e => setReason(e.target.value)} onKeyDown={e => e.key === 'Enter' && onFail?.(card, reason)} placeholder="Why not? (optional)" value={reason} />
          <button className="btn sm ghost" onClick={() => setReason(null)} type="button">
            Back
          </button>
          <button className="btn sm danger" onClick={() => onFail?.(card, reason)} type="button">
            Send
          </button>
        </div>
      ) : (
        <div className="secret-actions">
          <small>{active ? 'Screen open. Press Done there when finished.' : computerOff ? 'Computer is off, it starts first.' : ''}</small>
          <button className="btn sm ghost" onClick={() => setReason('')} type="button">
            Can't do it
          </button>
          <button className="btn sm primary" onClick={() => onOpen?.(card)} type="button">
            <Icon name={computerOff ? 'play' : 'expand'} size={13} /> {computerOff ? 'Start' : 'Open screen'}
          </button>
        </div>
      )}
    </div>
  )
}

function SecretCardView({
  card,
  who,
  onSave,
  onCancel
}: {
  card: SecretCard
  who: string
  onSave?: (card: SecretCard, value: string) => Promise<void>
  onCancel?: (card: SecretCard) => void
}) {
  // The value lives only in this input's state until it's sent to Hermes; it's cleared right after.
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const open = card.status === 'open' && !!onSave

  const save = () => {
    if (!open || !value.trim() || busy) {
      return
    }

    setBusy(true)
    setError('')
    onSave?.(card, value)
      .then(() => setValue(''))
      .catch(err => setError(String((err as Error).message || err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="secret-card" data-status={card.status}>
      <div className="secret-head">
        <span className="tile">
          <Icon name="key" size={15} />
        </span>
        <span className="txt">
          <b>{card.label}</b>
          <small>
            {who} needs <code>{card.name}</code>
          </small>
        </span>
      </div>
      {card.description ? <p className="secret-desc">{card.description}</p> : null}
      {open ? (
        <>
          <div className="secret-input">
            <input
              aria-label={card.label}
              autoComplete="off"
              data-1p-ignore
              onChange={event => setValue(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && save()}
              placeholder="Paste the value"
              spellCheck={false}
              type={show ? 'text' : 'password'}
              value={value}
            />
            <button aria-label={show ? 'Hide' : 'Show'} className="icon-btn xs ghost" onClick={() => setShow(v => !v)} title={show ? 'Hide' : 'Show'} type="button">
              <Icon name={show ? 'eye-off' : 'eye'} size={15} />
            </button>
          </div>
          {error ? <div className="secret-error">{error}</div> : null}
          <div className="secret-actions">
            <small>Saved to {who}'s Hermes profile (.env). Never shown in chat or to the bot.</small>
            <button className="btn sm ghost" disabled={busy} onClick={() => onCancel?.(card)} type="button">
              Cancel
            </button>
            <button className="btn sm primary" disabled={busy || !value.trim()} onClick={save} type="button">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      ) : (
        <div className="secret-done">
          {card.status === 'saved' ? (
            <>
              <Icon name="check" size={13} /> Saved
            </>
          ) : card.status === 'cancelled' ? (
            'Cancelled'
          ) : (
            'Waiting'
          )}
        </div>
      )}
    </div>
  )
}

function AskCardView({ card, onAnswer }: { card: AskCard; onAnswer?: (card: AskCard, picked: string[], custom: string) => void }) {
  const [picked, setPicked] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const open = card.status === 'open' && !!onAnswer
  const chosen = card.status === 'answered' ? card.picked || [] : picked
  const canSend = (card.multi ? picked.length > 0 : false) || !!custom.trim()

  const pick = (label: string) => {
    if (!open) {
      return
    }

    if (card.multi) {
      setPicked(list => (list.includes(label) ? list.filter(l => l !== label) : [...list, label]))
    } else {
      onAnswer?.(card, [label], '')
    }
  }

  const send = () => {
    if (open && canSend) {
      onAnswer?.(card, card.multi ? picked : [], custom)
    }
  }

  return (
    <div className="ask-card" data-status={card.status}>
      <div className="ask-prompt">
        <Markdown text={card.prompt} />
      </div>
      <div className="ask-options" role={card.multi ? 'group' : undefined}>
        {card.options.map(option => (
          <button
            aria-pressed={card.multi ? chosen.includes(option.label) : undefined}
            className="ask-option"
            data-picked={chosen.includes(option.label) || undefined}
            data-style={option.style && option.style !== 'default' ? option.style : undefined}
            disabled={!open}
            key={option.label}
            onClick={() => pick(option.label)}
            type="button"
          >
            {card.multi ? <span className="ask-check">{chosen.includes(option.label) ? <Icon name="check" size={11} /> : null}</span> : null}
            <span className="ask-label">
              <b>{option.label}</b>
              {option.description ? <small>{option.description}</small> : null}
            </span>
          </button>
        ))}
      </div>
      {open && (card.allowCustom || card.multi) ? (
        <div className="ask-send">
          {card.allowCustom ? (
            <input
              aria-label="Your own answer"
              onChange={event => setCustom(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  send()
                }
              }}
              placeholder="Or type your own answer"
              value={custom}
            />
          ) : (
            <span className="ask-hint">Pick any that apply</span>
          )}
          <button className="btn sm" disabled={!canSend} onClick={send} type="button">
            Send
          </button>
        </div>
      ) : null}
      {card.status === 'answered' && card.custom ? <div className="ask-custom">“{card.custom}”</div> : null}
      {card.status === 'dismissed' ? <div className="ask-foot">Not answered</div> : null}
    </div>
  )
}

function BubbleActions({ text, who, member, react, thread, speak, scope }: { text: string; who: string; member?: string; react?: ChatMsg; thread?: () => void; speak?: string; scope?: string }) {
  return (
    <span className="bubble-actions">
      {react ? <ReactButton msg={react} /> : null}
      {speak ? <ReadAloudButton id={speak} text={text} /> : null}
      {thread ? (
        <button aria-label="Reply in thread" className="icon-btn xs ghost" onClick={thread} title="Reply in thread" type="button">
          <Icon name="thread" size={14} />
        </button>
      ) : null}
      <button aria-label="Copy" className="icon-btn xs ghost" onClick={() => copyMessage(text)} title="Copy" type="button">
        <Icon name="copy" size={14} />
      </button>
      <button aria-label="Reply" className="icon-btn xs ghost" onClick={() => $quote.set({ who, text, member, scope })} title="Reply" type="button">
        <Icon name="reply" size={14} />
      </button>
    </span>
  )
}

const shortAgo = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))

  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`

  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Under a thread root: "3 replies · 5m ago" with who replied. */
function ThreadLink({ msg, botFor, onOpen }: { msg: ChatMsg; botFor: (msg: ChatMsg) => Bot | null; onOpen: () => void }) {
  const info = msg.replies

  if (!info) {
    return null
  }

  return (
    <button className="thread-link" onClick={onOpen} type="button">
      <span className="thread-faces">
        {info.who.slice(0, 4).map(who =>
          who === 'user' ? (
            <span className="thread-you" key={who}>
              {($userName.get() || 'You').slice(0, 1).toUpperCase()}
            </span>
          ) : (
            <Avatar badge={false} bot={botFor({ id: '', role: 'assistant', text: '', at: 0, from: who })} key={who} size={18} />
          )
        )}
      </span>
      <b>
        {info.count} {info.count === 1 ? 'reply' : 'replies'}
      </b>
      <small>{shortAgo(info.at)}</small>
    </button>
  )
}

const bubbleMenu = (text: string, who: string, member?: string, scope?: string) => [
  { icon: 'copy' as const, label: 'Copy text', onSelect: () => copyMessage(text) },
  { icon: 'reply' as const, label: 'Reply', onSelect: () => $quote.set({ who, text, member, scope }) }
]

/** The local copy of an attachment (thumbnail, download), found by id or by the name Hermes stored it under. */
function localCopy(items: LibraryItem[], scope: string | undefined, att: MsgAttachment): LibraryItem | undefined {
  return items.find(item => (scope && item.id === `${scope}|${att.id}`) || (item.ref && item.ref === (att.ref || att.name)))
}

export async function openImage(att: Pick<MsgAttachment, 'name'>, local: LibraryItem | undefined, preview?: string) {
  $lightbox.set({ name: att.name, src: preview || '' })

  if (local) {
    const blob = await blobOf(local.id)

    if (blob) {
      $lightbox.set({ name: att.name, src: await readAsDataUrl(blob) })
    }
  }
}

export function FileGlyph({ name }: { name: string }) {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] || 'file').toLowerCase()

  return <span className="file-glyph">{ext}</span>
}

/** One file a bot sent: an inline picture, a player, or a chip with Download / Open. Bytes load on demand. */
/** App tools whose result shows as its own card or attachment, not as a step. */
const isCardTool = (name: string) => /(^|__)(send_file|request_secret|request_user_help)$/.test(name)

function BotFileView({ file }: { file: BotFile }) {
  const kind = kindOf(file)
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState('')
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState<'' | 'open' | 'save'>('')
  const inlineImage = kind === 'image' && (file.size || 0) <= 8 * 1024 * 1024

  useEffect(() => {
    if (!inlineImage && !playing) {
      return
    }

    let live = true
    fetchBotFile(file)
      .then(url => live && setSrc(url))
      .catch(error => live && setFailed(String((error as Error).message || error)))

    return () => {
      live = false
    }
  }, [file.path, inlineImage, playing])

  const act = (what: 'open' | 'save') => {
    setBusy(what)
    ;(what === 'save' ? saveBotFile(file).then(() => undefined) : openBotFile(file))
      .catch(error => toast(String((error as Error).message || error), 'bad'))
      .finally(() => setBusy(''))
  }

  if (inlineImage && !failed) {
    return (
      <button className="att-img bot-file-img" onClick={() => src && $lightbox.set({ name: file.name, src })} title={file.name} type="button">
        {src ? <img alt={file.name} src={src} /> : <span className="bot-file-loading"><span className="spinner xs" /></span>}
      </button>
    )
  }

  if ((kind === 'video' || kind === 'audio') && playing && src) {
    return kind === 'video' ? <video autoPlay className="bot-file-video" controls src={src} /> : <audio autoPlay className="bot-file-audio" controls src={src} />
  }

  return (
    <div className="att-file bot-file">
      <FileGlyph name={file.name} />
      <span>
        <b title={file.name}>{file.name}</b>
        <small>{[file.size ? humanSize(file.size) : '', failed].filter(Boolean).join(' · ') || (file.mime || 'File')}</small>
      </span>
      <span className="bot-file-actions">
        {(kind === 'video' || kind === 'audio') && playable(file) ? (
          <button aria-label="Play" className="icon-btn xs ghost" onClick={() => setPlaying(true)} title="Play" type="button">
            {playing ? <span className="spinner xs" /> : <Icon name="play" size={14} />}
          </button>
        ) : null}
        <button aria-label="Open" className="icon-btn xs ghost" disabled={!!busy} onClick={() => act('open')} title="Open with the default app" type="button">
          {busy === 'open' ? <span className="spinner xs" /> : <Icon name="expand" size={14} />}
        </button>
        <button aria-label="Download" className="icon-btn xs ghost" disabled={!!busy} onClick={() => act('save')} title="Download" type="button">
          {busy === 'save' ? <span className="spinner xs" /> : <Icon name="download" size={14} />}
        </button>
      </span>
    </div>
  )
}

function BotFiles({ files }: { files: BotFile[] }) {
  return (
    <div className="bot-files">
      {files.map(file => (
        <BotFileView file={file} key={file.path} />
      ))}
    </div>
  )
}

/**
 * An image the bot sent is a shot of its own desktop: it has no other camera.
 * The same screen is live in its Computer tab, so offer that as a doorway
 * instead of leaving the user to track down the tab — or take a raw VNC link
 * from the bot, which shows the same server with none of the app around it.
 */
function hasScreenShot(msg: ChatMsg) {
  return msg.role === 'assistant' && (msg.files || []).some(file => kindOf(file) === 'image')
}

function ScreenChip({ bot, label }: { bot: string; label: string }) {
  return (
    <button
      className="screen-chip"
      onClick={() => showComputerTab(bot)}
      title={`Open ${label}'s Computer tab — watch its screen live, and take it over when you want`}
      type="button"
    >
      <Icon name="computer" size={12} />
      See it live in the Computer tab
    </button>
  )
}

export function Attachments({ items, scope }: { items: MsgAttachment[]; scope?: string }) {
  const library = useStore($library)
  const local = scope ? library[scope] || [] : []

  return (
    <div className="att-stack">
      {items.map(att => {
        const copy = localCopy(local, scope, att)
        const thumb = att.thumb || copy?.thumb

        if (att.kind === 'image' && thumb) {
          return (
            <button className="att-img" key={att.id} onClick={() => void openImage(att, copy, thumb)} title={att.name} type="button">
              <img alt={att.name} src={thumb} />
            </button>
          )
        }

        const size = att.size || copy?.size

        return (
          <button
            className="att-file"
            disabled={!copy}
            key={att.id}
            onClick={() => copy && void downloadAttachment(copy).then(res => res === 'missing' && toast('That file is no longer on this device', 'bad'))}
            title={copy ? `Save ${att.name}` : att.name}
            type="button"
          >
            <FileGlyph name={att.name} />
            <span>
              <b>{att.name}</b>
              {size ? <small>{humanSize(size)}</small> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function Lightbox() {
  const open = useStore($lightbox)

  useEffect(() => {
    if (!open) {
      return
    }

    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && $lightbox.set(null)
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) {
    return null
  }

  return (
    <div className="lightbox" onClick={() => $lightbox.set(null)} role="presentation">
      {open.src ? <img alt={open.name} onClick={event => event.stopPropagation()} src={open.src} /> : <span className="spinner" />}
      <span className="lightbox-name">{open.name}</span>
    </div>
  )
}

export function TopBar({ title, onTitle, extra }: { title: ReactNode; onTitle?: () => void; extra?: ReactNode }) {
  const panelOpen = useStore($panelOpen)

  return (
    <div className="center-top">
      <div className="drag-fill" />
      <button className="title-pill" onClick={onTitle} type="button">
        {title}
      </button>
      {extra ? <div className="top-extra">{extra}</div> : null}
      <div className="drag-fill" />
      {!panelOpen ? (
        <button aria-label="Show details" className="icon-btn panel-toggle" onClick={() => $panelOpen.set(true)} type="button">
          <Icon name="panel" />
        </button>
      ) : null}
    </div>
  )
}

function dayLabel(at: number): string {
  const date = new Date(at)
  const now = new Date()
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000)

  if (days === 0) {
    return `Today ${time}`
  }

  if (days === 1) {
    return `Yesterday ${time}`
  }

  if (days < 7) {
    return `${date.toLocaleDateString([], { weekday: 'long' })} ${time}`
  }

  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' })} ${time}`
}

function Tools({ tools: all }: { tools: ToolCall[] }) {
  const [open, setOpen] = useState(false)
  // Reactions show as pills, not steps.
  const tools = all.filter(tool => !isReactTool(tool.name) && !isAskTool(tool.name) && !isCardTool(tool.name))

  if (!tools.length) {
    return null
  }

  // One quiet line ("Ran 12 steps", or what it's doing right now); the raw details only on click.
  const live = [...tools].reverse().find(tool => !tool.done)
  const count = `${tools.length} step${tools.length === 1 ? '' : 's'}`
  // MCP tools arrive as `mcp__<server>__<tool>`: the tool's own name reads better.
  const nice = (tool: ToolCall) => tool.name.replace(/^mcp__.+?__/, '').replace(/_/g, ' ')

  return (
    <div className="tools" data-open={open || undefined}>
      <button aria-expanded={open} className="tool summary" onClick={() => setOpen(v => !v)} type="button">
        {live ? <span className="spinner xs" /> : <Icon name="check" size={12} />}
        <b>{live ? `${nice(live)[0].toUpperCase()}${nice(live).slice(1)}…` : `Ran ${count}`}</b>
        {live && tools.length > 1 ? <span>{count}</span> : null}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {open
        ? tools.map(tool => (
            <div className="tool" data-done={tool.done || undefined} key={tool.id} title={tool.summary || tool.label}>
              {tool.done ? <Icon name="check" size={12} /> : <span className="spinner xs" />}
              <b>{nice(tool)}</b>
              {tool.label ? <span>{tool.label}</span> : null}
            </div>
          ))
        : null}
    </div>
  )
}

interface ThreadProps {
  messages: ChatMsg[]
  botFor: (msg: ChatMsg) => Bot | null
  group?: boolean
  empty?: ReactNode
  typing?: { bot: Bot | null } | null
  footer?: ReactNode
  /** Where this chat's attachments are kept (`bot:<name>` or `room:<id>`). */
  scope?: string
  /** Risky actions bots in this chat asked to do: cards while waiting, one-line records after. */
  approvals?: Approval[]
  /** The user toggles a reaction on a bot's message. Omitted: no react button. */
  onReact?: (msg: ChatMsg, emoji: string) => void
  /** The user answers a bot's question card. Omitted: cards are read-only. */
  onAnswer?: (msg: ChatMsg, picked: string[], custom: string) => void
  /** The user saves / cancels a secret card (1:1 only). */
  onSecretSave?: (card: SecretCard, value: string) => Promise<void>
  onSecretCancel?: (card: SecretCard) => void
  /** Sign-in handoff cards (1:1 only). */
  onHelpOpen?: (card: HelpCard) => void
  onHelpFail?: (card: HelpCard, reason: string) => void
  /** The handoff card whose screen is open right now, and whether the bot's computer is off. */
  helpState?: { activeId?: string; computerOff?: boolean }
  /** Open a message's thread (hover "Reply in thread", the "N replies" link). Omitted: no threads here. */
  onThread?: (msg: ChatMsg) => void
}

/** Messages drawn at first, and added per "Show earlier/newer messages": a chat of thousands drawn at once froze the app for seconds. */
const PAGE = 150
/** Messages drawn above a search result that's further back than what's drawn. */
const JUMP_CONTEXT = 10

export function Thread({ messages, botFor, group, empty, typing, footer, scope, approvals = [], onReact, onAnswer, onSecretSave, onSecretCancel, onHelpOpen, onHelpFail, helpState, onThread }: ThreadProps) {
  const picker = useStore($reactPicker)
  // Who reacted, for the pill's tooltip: "You" or the bot's display name.
  const nameOf = (who: string) => (who === USER ? 'You' : botFor({ id: '', role: 'assistant', text: '', at: 0, from: who })?.display || who)
  const scroller = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  // Where we last scrolled to ourselves. The scroll event for it can land after content has grown.
  const autoTop = useRef(-1)

  const toBottom = (el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight
    autoTop.current = el.scrollTop
  }

  useEffect(() => {
    if (scope) {
      void loadLibrary(scope)
    }
  }, [scope])

  // A search result to show: scroll to it and flash it, once it's rendered here.
  const jump = useStore($jumpTo)
  // Long chats draw part of themselves: normally their latest `count` messages, or `count` from
  // `from` after a jump to an older search result. Resets per chat.
  const [win, setWin] = useState<{ scope: string | undefined; from: number | null; count: number }>({ scope, from: null, count: PAGE })
  const current = win.scope === scope ? win : { scope, from: null, count: PAGE }
  let start = current.from === null ? Math.max(0, messages.length - current.count) : Math.min(current.from, messages.length)
  let end = current.from === null ? messages.length : Math.min(messages.length, current.from + current.count)
  const jumpAt = jump && jump.scope === scope ? messages.findIndex(msg => msg.id === jump.id) : -1

  // A search result outside what's drawn: draw the messages around it, not everything after it.
  if (jumpAt >= 0 && (jumpAt < start || jumpAt >= end)) {
    start = Math.max(0, jumpAt - JUMP_CONTEXT)
    end = Math.min(messages.length, start + PAGE)
  }

  const shown = start || end < messages.length ? messages.slice(start, end) : messages
  const latest = end >= messages.length
  // Distance from the bottom to restore after "Show earlier messages": the browser's own scroll
  // anchoring is off at the very top, so the reader would land on the oldest message drawn.
  const keepFromBottom = useRef<number | null>(null)
  const drawRange = (from: number, to: number) => setWin({ scope, from: to >= messages.length ? null : from, count: to - from })

  const showEarlier = () => {
    const el = scroller.current
    keepFromBottom.current = el ? el.scrollHeight - el.scrollTop : null
    drawRange(Math.max(0, start - PAGE), end)
  }

  const showNewer = () => drawRange(start, Math.min(messages.length, end + PAGE))

  const toLatest = () => {
    pinned.current = true
    setWin({ scope, from: null, count: PAGE })
  }

  // Sending while reading older messages goes back to the latest, where the message is.
  const lastId = messages[messages.length - 1]?.id
  const lastSeen = useRef<{ scope: string | undefined; id: string | undefined }>({ scope, id: lastId })

  useEffect(() => {
    const before = lastSeen.current
    lastSeen.current = { scope, id: lastId }

    if (before.scope === scope && before.id !== lastId && !latest && messages[messages.length - 1]?.role === 'user') {
      toLatest()
    }
  }, [scope, lastId])

  useEffect(() => {
    if (!jump || jump.scope !== scope) return
    const el = scroller.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(jump.id)}"]`)
    if (!el) return
    // Keep the result drawn after the jump is done.
    drawRange(start, end)
    pinned.current = false
    el.scrollIntoView({ block: 'center', behavior: 'auto' })
    el.classList.remove('flash')
    void el.offsetWidth
    el.classList.add('flash')
    if (!('demoFlash' in document.body.dataset)) setTimeout(() => el.classList.remove('flash'), 2200)
    $jumpTo.set(null)
  }, [jump, scope, messages])

  useLayoutEffect(() => {
    const el = scroller.current

    if (el && pinned.current) {
      toBottom(el)
    }

    if (el && keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current
      autoTop.current = el.scrollTop
      keepFromBottom.current = null
    }
  })

  // Pictures, highlighted code and math can grow a message after it's drawn: stay at the bottom.
  useEffect(() => {
    const el = scroller.current
    const inner = el?.firstElementChild

    if (!el || !inner || typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      if (pinned.current) {
        toBottom(el)
      }
    })
    observer.observe(inner)

    return () => observer.disconnect()
  }, [])

  const onScroll = () => {
    const el = scroller.current

    if (el && Math.abs(el.scrollTop - autoTop.current) > 1) {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
  }

  const rows: ReactNode[] = []
  let lastAt = 0
  // Answered approvals outside the drawn messages stay out with them; open ones always show.
  const fromAt = start ? shown[0]?.at || 0 : 0
  const toAt = latest ? Infinity : shown[shown.length - 1]?.at ?? Infinity
  const asks = approvals.filter(card => (card.at >= fromAt && card.at <= toAt) || card.status === 'pending' || card.status === 'sending').sort((a, b) => a.at - b.at)
  let nextAsk = 0

  if (start) {
    rows.push(
      <button className="thread-more" key="thread-more" onClick={showEarlier} type="button">
        Show earlier messages
      </button>
    )
  }

  // Approvals sit in the thread by time, between the messages around them.
  const flushAsks = (until: number) => {
    while (nextAsk < asks.length && asks[nextAsk].at <= until) {
      const card = asks[nextAsk++]
      rows.push(<ApprovalRow bot={botFor({ id: card.id, role: 'assistant', text: '', at: card.at, from: card.bot })} card={card} group={group} key={`ap${card.id}`} />)
    }
  }

  shown.forEach((msg, index) => {
    flushAsks(msg.at)

    if (msg.at && msg.at - lastAt > 30 * 60_000) {
      rows.push(
        <div className="day" key={`d${msg.id}`}>
          {dayLabel(msg.at)}
        </div>
      )
    }

    if (msg.at) {
      lastAt = msg.at
    }

    const prev = shown[index - 1]
    const next = shown[index + 1]

    if (msg.role === 'user') {
      rows.push(
        <div className="msg user" key={msg.id}>
          {voiceOf(msg) ? (
            <UserVoice msg={msg} scope={scope} />
          ) : msg.attachments?.length ? (
            <Attachments items={msg.attachments} scope={scope} />
          ) : null}
          {msg.text && !voiceOf(msg) ? (
            <div className="bubble-row">
              <BubbleActions text={msg.text} thread={onThread && msg.threadId ? () => onThread(msg) : undefined} who="You" />
              <div className="bubble user-bubble" onContextMenu={event => openContextMenu(event, bubbleMenu(msg.text, 'You'))}>
                <Markdown text={msg.text} />
              </div>
            </div>
          ) : null}
          <Reactions msg={msg} nameOf={nameOf} />
          {onThread && msg.replies ? <ThreadLink botFor={botFor} msg={msg} onOpen={() => onThread(msg)} /> : null}
          {msg.thinking ? <div className="msg-note">{reasoningLabel(msg.thinking)} thinking</div> : null}
          {msg.waiting ? <div className="msg-note">Waiting for connection, sends when Hermes is back</div> : null}
        </div>
      )

      return
    }

    if (msg.routine) {
      // A routine's output, delivered here by Hermes; the bot's reply to it follows.
      rows.push(
        <div className="msg routine-result" key={msg.id}>
          <details>
            <summary>
              <Icon name="clock" size={13} />
              <span>
                Routine <b>{msg.routine}</b> ran{msg.at ? ` at ${new Date(msg.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
              </span>
              <Icon className="chev" name="chevron-down" size={13} />
            </summary>
            <div className="routine-output">
              <Markdown text={msg.text || '(no output)'} />
            </div>
          </details>
        </div>
      )

      return
    }

    if (msg.note) {
      rows.push(
        <div className="msg self-note" key={msg.id}>
          <span>
            <Icon name="edit" size={12} />
            {msg.text}
            {msg.at ? <small>{new Date(msg.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small> : null}
          </span>
        </div>
      )

      return
    }

    if (msg.role === 'error') {
      rows.push(
        <div className="msg notice" key={msg.id}>
          <span>{msg.text}</span>
        </div>
      )

      return
    }

    // A turn that only reacted (no text): the reaction shows on the user's message, no empty bubble.
    if (!msg.text.trim() && !msg.streaming && (msg.tools || []).length && (msg.tools || []).every(tool => isReactTool(tool.name) || isAskTool(tool.name) || isCardTool(tool.name))) {
      return
    }

    const bot = botFor(msg)
    const sameAsPrev = prev && prev.role === 'assistant' && botFor(prev)?.name === bot?.name && msg.at - prev.at < 5 * 60_000
    const sameAsNext = next && next.role === 'assistant' && botFor(next)?.name === bot?.name
    const empty = !msg.text && msg.streaming && !(msg.tools || []).length

    rows.push(
      <div className="msg bot" data-group={group || undefined} key={msg.id}>
        {group ? <span className="msg-face">{!sameAsNext ? <Avatar activity={Boolean(msg.streaming)} badge={false} bot={bot} size={26} /> : null}</span> : null}
        <div className="msg-col">
          {group && (!sameAsPrev || msg.via) && bot ? (
            <span className="msg-name" style={{ color: crewColor(bot) }}>
              {bot.display}
              {msg.via === 'dm' ? (
                <span className="msg-via" title={`${bot.display} posted this from their 1:1 chat with you`}>
                  <Icon name="share" /> from 1:1 chat
                </span>
              ) : null}
            </span>
          ) : null}
          <Tools tools={msg.tools || []} />
          {msg.help ? (
            <HelpCardView
              active={helpState?.activeId === msg.help.id}
              card={msg.help}
              computerOff={helpState?.computerOff}
              onFail={onHelpFail}
              onOpen={onHelpOpen}
              who={bot?.display || 'The bot'}
            />
          ) : msg.helpAsk ? (
            <div className="secret-pointer">
              <Icon name="computer" size={13} />
              <span>
                Needs you on its screen: <b>{msg.helpAsk.instruction}</b> Open your 1:1 with {bot?.display || 'the bot'} to take over.
              </span>
              {bot ? (
                <button className="link-btn" onClick={() => $selection.set({ kind: 'bot', id: bot.name })} type="button">
                  Open 1:1
                </button>
              ) : null}
            </div>
          ) : msg.secret ? (
            <SecretCardView card={msg.secret} onCancel={onSecretCancel} onSave={onSecretSave} who={bot?.display || 'The bot'} />
          ) : msg.secretAsk ? (
            <div className="secret-pointer">
              <Icon name="key" size={13} />
              <span>
                Asked for <b>{msg.secretAsk.label}</b>. Open your 1:1 with {bot?.display || 'the bot'} to enter this.
              </span>
              {bot ? (
                <button className="link-btn" onClick={() => $selection.set({ kind: 'bot', id: bot.name })} type="button">
                  Open 1:1
                </button>
              ) : null}
            </div>
          ) : msg.ask ? (
            <AskCardView card={msg.ask} onAnswer={onAnswer ? (_card, picked, custom) => onAnswer(msg, picked, custom) : undefined} />
          ) : empty ? (
            <div className="bubble typing">
              <i />
              <i />
              <i />
            </div>
          ) : msg.text && !msg.files?.some(f => f.voice) ? (
            <div className="bubble-row">
              <div
                className="bubble"
                data-streaming={msg.streaming || undefined}
                onContextMenu={event => openContextMenu(event, bubbleMenu(msg.text, bot?.display || 'Bot', bot?.name))}
              >
                <Markdown streaming={msg.streaming} text={msg.text} />
                {msg.stopped ? <small className="msg-stopped">Stopped · reply was interrupted</small> : null}
              </div>
              {msg.streaming ? null : <BubbleActions react={onReact ? msg : undefined} scope={scope} speak={msg.id} text={msg.text} thread={onThread && msg.threadId ? () => onThread(msg) : undefined} who={bot?.display || 'Bot'} member={group ? bot?.name : undefined} />}
              {onReact && picker === msg.id && !msg.streaming ? <ReactPicker msg={msg} onReact={onReact} /> : null}
            </div>
          ) : null}
          {msg.files?.some(f => f.voice) ? (
            <VoiceMemo caption={msg.text} file={msg.files.find(f => f.voice)!} />
          ) : msg.files?.length ? (
            <BotFiles files={msg.files} />
          ) : null}
          {!group && bot && hasScreenShot(msg) ? <ScreenChip bot={bot.name} label={bot.display} /> : null}
          {msg.streaming ? null : <Reactions msg={msg} nameOf={nameOf} onReact={onReact} />}
          {onThread && msg.replies ? <ThreadLink botFor={botFor} msg={msg} onOpen={() => onThread(msg)} /> : null}
        </div>
      </div>
    )
  })

  flushAsks(Infinity)

  if (!latest) {
    rows.push(
      <div className="thread-newer" key="thread-newer">
        <button className="thread-more" onClick={showNewer} type="button">
          Show newer messages
        </button>
        <button className="thread-more" onClick={toLatest} type="button">
          Jump to latest
        </button>
      </div>
    )
  }

  if (typing && latest) {
    rows.push(
      <div className="msg bot" data-group={group || undefined} key="typing">
        {group ? (
          <span className="msg-face">
            <Avatar activity badge={false} bot={typing.bot} size={26} />
          </span>
        ) : null}
        <div className="msg-col">
          {group && typing.bot ? (
            <span className="msg-name" style={{ color: crewColor(typing.bot) }}>
              {typing.bot.display}
            </span>
          ) : null}
          <div className="bubble typing">
            <i />
            <i />
            <i />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="thread" onScroll={onScroll} ref={scroller}>
      <div className="thread-inner">
        {messages.length || asks.length || typing ? rows.map(row => (isValidElement(row) && row.key ? cloneElement(row as React.ReactElement<Record<string, unknown>>, { 'data-msg-id': String(row.key) }) : row)) : empty}
        {footer}
      </div>
    </div>
  )
}

// Deny on the left, the narrowest allow on the right.
const BUTTON_ORDER: ApprovalChoice[] = ['deny', 'always', 'session', 'once']

const CHOICE_HINT: Partial<Record<ApprovalChoice, string>> = {
  session: 'Stop asking for this in this chat',
  always: 'Add it to this bot’s allow list for good'
}

/** A risky action a bot asked to do: a card while it waits, then a one-line record of the answer. */
function ApprovalRow({ card, bot, group }: { card: Approval; bot: Bot | null; group?: boolean }) {
  const who = bot?.display || card.bot

  if (card.status !== 'pending' && card.status !== 'sending' && card.status !== 'expired') {
    return (
      <div className="msg approval-line" data-denied={card.status === 'deny' || undefined} data-group={group || undefined} title={card.description || undefined}>
        <Icon name={card.status === 'deny' ? 'close' : 'check'} size={12} />
        <span>
          {group ? <b>{who} · </b> : null}
          {RECORD_LABEL[card.status]}
          {card.note ? ` (${card.note})` : ''}:
        </span>
        <code>{shortAction(card)}</code>
      </div>
    )
  }

  const waiting = card.status === 'pending'
  const hint = (choice: ApprovalChoice) =>
    choice === 'session' && card.kind === 'pc'
      ? card.action
        ? `Stop asking about ${pcNoun(card.action)} in this chat`
        : 'Allow this kind of action for the rest of this chat'
      : CHOICE_HINT[choice]

  return (
    <div className="msg bot" data-group={group || undefined}>
      {group ? (
        <span className="msg-face">
          <Avatar badge={false} bot={bot} size={26} />
        </span>
      ) : null}
      <div className="msg-col">
        <div className="prompt-card approval-card" data-expired={card.status === 'expired' || undefined}>
          <div className="prompt-head">
            <Icon name={card.kind === 'pc' ? 'computer' : 'shield'} size={16} />
            <span>
              <b>{who}</b> {KIND_ASK[card.kind]}
            </span>
          </div>
          <pre className="prompt-cmd">{card.command}</pre>
          {card.description ? <p>{card.description}</p> : null}
          {card.flagged ? <p className="approval-flag">Hermes’s safety check flagged this, so it can only be allowed once.</p> : null}
          {card.status === 'expired' ? (
            <p className="approval-expired">Expired{card.note ? ` · ${card.note}` : ''}</p>
          ) : null}
          <div className="prompt-actions">
            {BUTTON_ORDER.filter(choice => card.choices.includes(choice)).map(choice => (
              <button
                className={`btn sm ${choice === 'deny' ? 'ghost' : choice === 'once' ? 'primary' : 'outline'}`}
                disabled={!waiting}
                key={choice}
                onClick={() => void answerApproval(card.id, choice)}
                title={hint(choice)}
                type="button"
              >
                {CHOICE_LABEL[choice]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function Composer({
  placeholder,
  onSend,
  onStop,
  running,
  disabled,
  mentionables,
  thinking,
  thinkingBot,
  secretBot,
  voice,
  scope
}: {
  placeholder: string
  onSend: (text: string, attachments: Pending[], opts: SendOptions) => void
  onStop?: () => void
  running?: boolean
  disabled?: boolean
  mentionables?: Bot[]
  /** Offer a thinking level for the next message only. */
  thinking?: boolean
  /** The bot whose default level the slider starts at. */
  thinkingBot?: string
  /** 1:1 chats: the bot a key pasted here can be saved for instead of sent. */
  secretBot?: { name: string; display: string; save: (name: string, value: string) => Promise<void> }
  /** The profile whose Hermes speech settings transcribe voice notes (none: no mic). */
  voice?: string
  /** Which chat this composer sends into. A reply quote is only ever valid for the chat it was picked in. */
  scope?: string
}) {
  const [text, setText] = useState('')
  // A message that looks like it holds an API key: held back until the user decides.
  const [keyWarn, setKeyWarn] = useState<null | { key: string; name: string }>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  const [think, setThink] = useState('')
  const [pick, setPick] = useState(0)
  const [files, setFiles] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  const filesRef = useRef<Pending[]>([])
  const quote = useStore($quote)
  filesRef.current = files

  useEffect(() => {
    if (quote) {
      area.current?.focus()
    }
  }, [quote])

  // A quote belongs to the chat it was picked in.
  useEffect(() => () => $quote.set(null), [])

  // Switching chat does not remount the composer, so a quote picked in the room we just left stays
  // attached: the next send would quote that room's text and address that room's author. A quote is
  // only ever valid for the scope it was picked in, so drop it on the way across.
  const quoteScope = useRef(scope)
  useEffect(() => {
    if (quoteScope.current === scope) return
    quoteScope.current = scope
    $quote.set(null)
  }, [scope])

  useEffect(() => {
    const el = area.current

    if (el) {
      el.style.height = '0px'
      el.style.height = `${Math.min(180, el.scrollHeight)}px`
    }
  }, [text])

  const addFiles = async (list: File[]) => {
    for (const file of list) {
      if (filesRef.current.length >= MAX_ATTACHMENTS) {
        toast(`You can attach up to ${MAX_ATTACHMENTS} files at once`, 'bad')

        break
      }

      const made = await makePending(file)

      if ('error' in made) {
        toast(made.error, 'bad')
      } else {
        filesRef.current = [...filesRef.current, made.pending]
        setFiles(filesRef.current)
      }
    }
  }

  // Drop files anywhere on the window; the composer lights up while they hover.
  useEffect(() => {
    if (disabled) {
      return
    }

    let depth = 0
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes('Files')

    const enter = (event: DragEvent) => {
      if (hasFiles(event)) {
        depth++
        setDragging(true)
      }
    }

    const leave = (event: DragEvent) => {
      if (hasFiles(event) && --depth <= 0) {
        depth = 0
        setDragging(false)
      }
    }

    const over = (event: DragEvent) => hasFiles(event) && event.preventDefault()

    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) {
        return
      }

      event.preventDefault()
      depth = 0
      setDragging(false)
      void addFiles(Array.from(event.dataTransfer?.files || []))
    }

    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)

    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [disabled])

  const mention = /(^|\s)@([a-z0-9_-]*)$/i.exec(text)
  const options =
    mention && mentionables
      ? mentionables
          .filter(bot => bot.handle.startsWith(mention[2].toLowerCase()) || bot.display.toLowerCase().startsWith(mention[2].toLowerCase()))
          .slice(0, 6)
      : []

  const complete = (bot: Bot) => {
    setText(text.replace(/@([a-z0-9_-]*)$/i, `@${bot.handle} `))
    area.current?.focus()
  }

  const canSend = Boolean(text.trim() || files.length)

  const send = (force = false) => {
    if (!canSend || disabled) {
      return
    }

    const found = force ? null : findKey(text)

    if (found) {
      setKeyWarn(found)

      return
    }

    setKeyWarn(null)

    // A quote picked in another chat is never carried across: it must not become quoted text here, and
    // it must not address that other chat's author.
    const live = quote && (!quote.scope || quote.scope === scope) ? quote : null
    onSend(live ? `> ${excerpt(live.text)}\n\n${text}` : text, files, { ...(think ? { reasoning: think } : {}), ...(live?.member ? { answerTo: live.member } : {}) })
    $quote.set(null)
    setThink('')
    setText('')
    filesRef.current = []
    setFiles([])
  }

  const saveKey = () => {
    if (!keyWarn || !secretBot || keyBusy || !NAME_RE.test(keyWarn.name)) {
      return
    }

    setKeyBusy(true)
    secretBot
      .save(keyWarn.name, keyWarn.key)
      .then(() => {
        // The key is removed from the draft; whatever else was typed stays for the user to send.
        setText(t => t.replace(keyWarn.key, '').trim())
        setKeyWarn(null)
        toast(`Saved ${keyWarn.name} for ${secretBot.display}`, 'good')
      })
      .catch(error => toast(String((error as Error).message || error), 'bad'))
      .finally(() => setKeyBusy(false))
  }

  return (
    <div className="composer-wrap" data-dragging={dragging || undefined}>
      {keyWarn ? (
        <div className="key-warn" role="alert">
          <Icon name="shield" size={15} />
          <div className="key-warn-text">
            <b>This looks like an API key.</b>
            <span>Sending it puts it in the chat history and the bot's context.{secretBot ? ` Save it as a secret for ${secretBot.display} instead:` : ''}</span>
            {secretBot ? (
              <div className="key-warn-row">
                <input
                  aria-label="Secret name"
                  onChange={event => setKeyWarn({ ...keyWarn, name: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                  spellCheck={false}
                  value={keyWarn.name}
                />
                <button className="btn sm primary" disabled={keyBusy || !NAME_RE.test(keyWarn.name)} onClick={saveKey} type="button">
                  {keyBusy ? 'Saving…' : 'Save as secret'}
                </button>
              </div>
            ) : null}
          </div>
          <div className="key-warn-actions">
            <button className="btn sm ghost" onClick={() => send(true)} type="button">
              Send anyway
            </button>
            <button className="btn sm ghost" onClick={() => setKeyWarn(null)} type="button">
              Edit
            </button>
          </div>
        </div>
      ) : null}
      {options.length ? (
        <div className="mentions">
          {options.map((bot, index) => (
            <button className="mention-opt" data-on={index === pick || undefined} key={bot.name} onMouseDown={e => (e.preventDefault(), complete(bot))} type="button">
              <Avatar badge={false} bot={bot} size={22} />
              <b>{bot.display}</b>
              <small>@{bot.handle}</small>
            </button>
          ))}
        </div>
      ) : null}
      {quote ? (
        <div className="quote-chip">
          <Icon name="reply" size={14} />
          <span>
            <b>{quote.who}</b>
            <small>{excerpt(quote.text)}</small>
          </span>
          <button aria-label="Cancel reply" className="icon-btn xs ghost" onClick={() => $quote.set(null)} type="button">
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}
      {files.length ? (
        <div className="attach-row">
          {files.map(item => (
            <div className="attach-chip" data-kind={item.kind === 'image' && item.thumb ? 'image' : 'file'} data-testid="attach-chip" key={item.id} title={`${item.name} · ${humanSize(item.size)}`}>
              {item.kind === 'image' && item.thumb ? <img alt={item.name} src={item.thumb} /> : <FileGlyph name={item.name} />}
              {item.kind !== 'image' || !item.thumb ? (
                <span>
                  <b>{item.name}</b>
                  <small>{humanSize(item.size)}</small>
                </span>
              ) : null}
              <button
                aria-label={`Remove ${item.name}`}
                className="attach-x"
                onClick={() => {
                  filesRef.current = filesRef.current.filter(f => f.id !== item.id)
                  setFiles(filesRef.current)
                }}
                type="button"
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="composer">
        <input
          hidden
          multiple
          onChange={event => {
            void addFiles(Array.from(event.target.files || []))
            event.target.value = ''
          }}
          ref={picker}
          type="file"
        />
        <button aria-label="Attach files" className="composer-plus" disabled={disabled} onClick={() => picker.current?.click()} title="Attach files or pictures" type="button">
          <Icon name="plus" size={17} />
        </button>
        {thinking ? <ThinkSlider bot={thinkingBot} disabled={disabled} onChange={setThink} value={think} /> : null}
        <textarea
          disabled={disabled}
          onChange={event => {
            setText(event.target.value)
            setPick(0)
          }}
          onKeyDown={event => {
            if (options.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              setPick(p => (p + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)

              return
            }

            if (options.length && (event.key === 'Tab' || event.key === 'Enter')) {
              event.preventDefault()
              complete(options[pick] || options[0])

              return
            }

            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={event => {
            const pasted = Array.from(event.clipboardData?.files || [])

            if (pasted.length) {
              event.preventDefault()
              void addFiles(pasted)
            }
          }}
          placeholder={placeholder}
          ref={area}
          rows={1}
          value={text}
        />
        {voice && !text.trim() && !files.length ? (
          <MicButton
            disabled={disabled}
            onSend={(spoken, recorded) => {
              onSend(quote ? `> ${excerpt(quote.text)}\n\n${spoken}` : spoken, recorded, {})
              $quote.set(null)
            }}
            profile={voice}
          />
        ) : null}
        {running && onStop ? (
          <button aria-label="Stop" className="composer-send stop" onClick={onStop} title="Stop this reply" type="button">
            <Icon name="stop" size={13} />
          </button>
        ) : null}
        {running && onStop && !canSend ? null : canSend ? (
          <button aria-label="Send" className="composer-send" onClick={() => send()} type="button">
            <Icon name="arrow-up" size={17} />
          </button>
        ) : (
          <button aria-label="Send" className="composer-send" disabled type="button">
            <Icon name="arrow-up" size={17} />
          </button>
        )}
      </div>
      {dragging ? <div className="drop-hint">Drop to attach</div> : null}
    </div>
  )
}

// ── the agent asking back ─────────────────────────────────────────────────
export function PromptCards({ sessionIds, bot }: { sessionIds: string[]; bot?: (sessionId: string) => Bot | null }) {
  const prompts = useStore($prompts).filter(p => sessionIds.includes(p.sessionId))

  if (!prompts.length) {
    return null
  }

  return (
    <div className="prompts">
      {prompts.map(prompt => (
        <PromptCard bot={bot?.(prompt.sessionId) || null} key={prompt.id} prompt={prompt} />
      ))}
    </div>
  )
}

/** Prompts from sessions no open view owns. */
export function OrphanPrompts({ known }: { known: string[] }) {
  const prompts = useStore($prompts).filter(p => !known.includes(p.sessionId) && p.method !== 'display.install.sudo')

  if (!prompts.length) {
    return null
  }

  return (
    <div className="orphan-prompts">
      {prompts.map(prompt => (
        <PromptCard bot={null} key={prompt.id} prompt={prompt} />
      ))}
    </div>
  )
}

function PromptCard({ prompt, bot }: { prompt: PendingPrompt; bot: Bot | null }) {
  const [value, setValue] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const who = bot?.display || 'A bot'
  const p = prompt.params

  if (prompt.method === 'approval') {
    const choices: string[] = Array.isArray(p.choices) && p.choices.length ? p.choices : ['once', 'session', 'always', 'deny']
    const label = (choice: string) =>
      ({ once: 'Allow once', session: 'Allow this chat', always: 'Always allow', deny: 'Deny' })[choice] || choice

    return (
      <div className="prompt-card">
        <div className="prompt-head">
          <Icon name="shield" size={16} />
          <b>{who} wants to run something</b>
        </div>
        {p.description ? <p>{String(p.description)}</p> : null}
        {p.command ? <pre className="prompt-cmd">{String(p.command)}</pre> : null}
        <div className="prompt-actions">
          {choices.map(choice => (
            <button
              className={`btn sm ${choice === 'deny' ? 'ghost' : choice === 'once' ? 'primary' : ''}`}
              key={choice}
              onClick={() => prompt.resolve({ choice })}
              type="button"
            >
              {label(choice)}
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (prompt.method === 'clarify') {
    const questions: { qid: string; question: string; choices?: string[] }[] = Array.isArray(p.questions) ? p.questions : []

    return (
      <div className="prompt-card">
        <div className="prompt-head">
          <Icon name="bell" size={16} />
          <b>{who} has a question</b>
        </div>
        {questions.map(q => (
          <div className="prompt-q" key={q.qid}>
            <p>{q.question}</p>
            {q.choices?.length ? (
              <div className="prompt-actions wrap">
                {q.choices.map(choice => (
                  <button
                    className={`btn sm ${answers[q.qid] === choice ? 'primary' : ''}`}
                    key={choice}
                    onClick={() => setAnswers({ ...answers, [q.qid]: choice })}
                    type="button"
                  >
                    {choice}
                  </button>
                ))}
              </div>
            ) : (
              <input className="input" onChange={e => setAnswers({ ...answers, [q.qid]: e.target.value })} placeholder="Your answer" value={answers[q.qid] || ''} />
            )}
          </div>
        ))}
        <div className="prompt-actions">
          <button className="btn sm ghost" onClick={() => prompt.resolve({ answers: {} })} type="button">
            Skip
          </button>
          <button className="btn sm primary" onClick={() => prompt.resolve({ answers })} type="button">
            Answer
          </button>
        </div>
      </div>
    )
  }

  const title =
    prompt.method === 'sudo' ? 'needs your password (sudo)' : prompt.method === 'vault.code' ? 'needs a one-time code' : `needs ${p.name || p.env_var || 'a secret'}`

  return (
    <div className="prompt-card">
      <div className="prompt-head">
        <Icon name="shield" size={16} />
        <b>
          {who} {title}
        </b>
      </div>
      {p.prompt || p.description ? <p>{String(p.prompt || p.description)}</p> : null}
      <input
        autoFocus
        className="input"
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && prompt.resolve({ value })}
        type={prompt.method === 'vault.code' ? 'text' : 'password'}
        value={value}
      />
      <div className="prompt-actions">
        <button className="btn sm ghost" onClick={() => prompt.reject(new Error('cancelled'))} type="button">
          Cancel
        </button>
        <button className="btn sm primary" onClick={() => prompt.resolve({ value })} type="button">
          Send
        </button>
      </div>
    </div>
  )
}

/** A user message that's a voice note: its marker, and the recording if it's attached. */
function voiceOf(msg: ChatMsg) {
  const voice = splitVoiceText(msg.text || '')

  return voice ? { ...voice, att: msg.attachments?.find(att => VOICE_NOTE_NAME.test(att.name)) } : null
}

function UserVoice({ msg, scope }: { msg: ChatMsg; scope?: string }) {
  const library = useStore($library)
  const voice = voiceOf(msg)!
  const others = (msg.attachments || []).filter(att => att !== voice.att)
  const copy = voice.att ? localCopy(scope ? library[scope] || [] : [], scope, voice.att) : undefined

  return (
    <>
      {others.length ? <Attachments items={others} scope={scope} /> : null}
      {voice.att ? (
        <VoiceNote att={voice.att} copyId={copy?.id || voice.att.id} transcribed={voice.transcribed} transcript={voice.transcript} />
      ) : (
        <div className="bubble user-bubble">
          <Markdown text={voice.transcript} />
        </div>
      )}
    </>
  )
}

import { MicButton, ReadAloudButton, VoiceMemo, VoiceNote } from './voice'
import { splitVoiceText, VOICE_NOTE_NAME } from '../lib/voice'

/**
 * Compact inline thinking-effort slider (Off … Max) for the next message only. Until moved it
 * sits at the bot's default level and sends nothing; Escape or double-click goes back to default.
 */
export function ThinkSlider({ bot, value, onChange, disabled }: { bot?: string; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const cfg = useStore($botConfig)[bot || '']
  const [show, setShow] = useState(false)
  const fallback = isLoaded(cfg) && cfg.reasoning ? cfg.reasoning.toLowerCase() : 'medium'
  const id = value || fallback
  const index = Math.max(0, REASONING_CHOICES.findIndex(choice => choice.id === id))
  const label = `${REASONING_CHOICES[index]?.label || 'Default'}${value ? '' : ' (default)'}`
  const max = REASONING_CHOICES.length - 1

  return (
    <div className="think-slider" data-default={value ? undefined : ''} data-level={index} data-show={show || undefined} title={`Thinking: ${label}`}>
      <span aria-hidden className="think-brain" style={{ ['--level' as string]: max ? `${index / max}` : '0' }}>
        <Icon name="brain" size={18} />
      </span>
      <input
        aria-label="Thinking effort for this message"
        className="think-range"
        aria-valuetext={label}
        disabled={disabled}
        max={max}
        min={0}
        onBlur={() => setShow(false)}
        onChange={event => onChange(REASONING_CHOICES[Number(event.target.value)].id)}
        onDoubleClick={() => onChange('')}
        onFocus={() => setShow(true)}
        onKeyDown={event => {
          if (event.key === 'Escape' && value) {
            event.preventDefault()
            onChange('')
          }
        }}
        onPointerDown={() => setShow(true)}
        onPointerUp={() => setShow(false)}
        step={1}
        style={{ ['--pct' as string]: `${(index / max) * 100}%` }}
        type="range"
        value={index}
      />
      <span aria-hidden className="think-tip">
        {label}
      </span>
    </div>
  )
}
