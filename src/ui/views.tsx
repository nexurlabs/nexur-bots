import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useState } from 'react'

import { $approvals, approvalsFor } from '../lib/approvals'
import { $askCards, chatCards } from '../lib/ask'
import { userAnswer } from '../lib/ask-actions'
import { $filePosts, chatFilePosts } from '../lib/bot-files'
import { $computerDemo } from '../lib/computer-demo'
import { gateway } from '../lib/gateway'
import { $handoff, $helpCards, cardsForBot, chatHelpCards } from '../lib/handoff'
import { finishHandoff, openHandoff } from '../lib/handoff-actions'
import { userCancelSecret, userSaveSecret } from '../lib/secret-actions'
import { $secretCards, chatSecretCards, saveSecret, savedNote } from '../lib/secrets'
import { userReact } from '../lib/react-actions'
import { $chatReactions, loadChatReactions, withChatReactions } from '../lib/reactions'
import { $jobs, stopJob, syncJobs, type Job } from '../lib/background'
import { $chats, $outbox, chatShowsHistory, loadBotChat, outboxMessages, runtimeFor, sendToBot, stopBot } from '../lib/chat'
import { $roomRunning, $rooms, $roomTyping, $roomWork, postToRoom, releaseHold, roomBots, stopRoom, type RoomTypingTurn } from '../lib/rooms'
import { $selfEditNotes, type SelfEditNote } from '../lib/self-edit'
import { $allBots, $bots, $lead, $panelOpen, $selection } from '../lib/store'
import type { Bot, ChatMsg, Room, WorkItem } from '../lib/types'
import { Avatar, AvatarStack } from './avatar'
import { $dialog } from './dialogs'
import { Icon } from './icons'
import { Composer, PromptCards, Thread, TopBar } from './thread'
import { $openThread, $threadPosts, assignChatThreads, chatRootIds, chatThreadPosts, splitThreads } from '../lib/threads'
import type { ReactNode } from 'react'

/** The thread pane: the root, its replies and a composer of its own, over the right of the chat. */
function ThreadPane({ title, children }: { title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !event.defaultPrevented && $openThread.set(null)
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <aside className="thread-pane" aria-label="Thread">
      <header className="thread-pane-head">
        <Icon name="thread" size={16} />
        <b>Thread</b>
        <span className="thread-pane-sub">{title}</span>
        <button aria-label="Close thread" className="icon-btn xs ghost" onClick={() => $openThread.set(null)} title="Close (Esc)" type="button">
          <Icon name="close" size={14} />
        </button>
      </header>
      {children}
    </aside>
  )
}

const rootOnly = (msg: ChatMsg): ChatMsg => {
  const { replies: _r, threadId: _t, ...rest } = msg

  return rest
}

function HoldBanner({ room, members }: { room: Room; members: Bot[] }) {
  const names = Object.keys(room.holds || {})

  if (!names.length) {
    return null
  }

  const labels = names.map(name => members.find(bot => bot.name === name)?.display || name)
  const allHeld = members.length > 0 && names.length >= members.length

  return (
    <div className="composer-wrap hold-wrap">
      <div className="banner hold">
        <Icon name="stop" size={18} />
        <div className="banner-text">
          <b>{allHeld ? 'Everyone is paused' : `${labels.join(', ')} ${labels.length > 1 ? 'are' : 'is'} paused`}</b>
          <span className="banner-hint">
            @mention a paused bot to pick it back up, or{' '}
            <button className="link-btn" onClick={() => releaseHold(room.key)} type="button">
              resume everyone
            </button>
            .
          </span>
        </div>
      </div>
    </div>
  )
}

/** Cards a bot posted in its 1:1 chat (questions, secret requests), in among the messages by time. */
function withCards(messages: ChatMsg[], cards: ChatMsg[]): ChatMsg[] {
  if (!cards.length) {
    return messages
  }

  const out: ChatMsg[] = []
  let next = 0

  for (const msg of messages) {
    while (msg.at && next < cards.length && cards[next].at < msg.at) {
      out.push(cards[next++])
    }

    out.push(msg)
  }

  out.push(...cards.slice(next))

  return out
}

const SUGGESTIONS = ['What can you do?', 'What are you working on?', 'Introduce yourself 👋']

/** The app's own lines (e.g. "Nova changed its label to Research") in among the messages, by time. */
function withNotes(messages: ChatMsg[], notes: SelfEditNote[]): ChatMsg[] {
  if (!notes.length) {
    return messages
  }

  const out: ChatMsg[] = []
  let next = 0

  for (const msg of messages) {
    while (msg.at && next < notes.length && notes[next].at < msg.at) {
      const note = notes[next++]
      out.push({ id: note.id, role: 'system', text: note.text, at: note.at, note: true })
    }

    out.push(msg)
  }

  for (const note of notes.slice(next)) {
    out.push({ id: note.id, role: 'system', text: note.text, at: note.at, note: true })
  }

  return out
}

export function BotChatView({ bot }: { bot: Bot }) {
  const chats = useStore($chats)
  useStore($outbox)
  const selfNotes = useStore($selfEditNotes)[bot.name] || []
  const switchNotes = useStore($switchNotes)[`bot:${bot.name}`]
  const notes = switchNotes?.length ? [...selfNotes, ...switchNotes].sort((a, b) => a.at - b.at) : selfNotes
  const approvals = approvalsFor(useStore($approvals), `bot:${bot.name}`)
  const state = chats[bot.name]

  useEffect(() => {
    void loadBotChat(bot.name)
  }, [bot.name])

  const runtime = runtimeFor(`bot:${bot.name}`)

  useEffect(() => {
    if (runtime) {
      void syncJobs(bot.name, runtime)
    }
  }, [bot.name, runtime])
  const reactions = useStore($chatReactions)
  const askCards = useStore($askCards)[`bot:${bot.name}`] ?? []
  const secretCards = useStore($secretCards)[`bot:${bot.name}`] ?? []
  const helpCards = cardsForBot(useStore($helpCards)[`bot:${bot.name}`] ?? [], bot.name)
  const filePosts = useStore($filePosts)[`bot:${bot.name}`] ?? []
  const threadPosts = useStore($threadPosts)[`bot:${bot.name}`] ?? []
  const openThread = useStore($openThread)
  const handoff = useStore($handoff)
  const [computerOff, setComputerOff] = useState(false)
  const openHelp = helpCards.some(card => card.status === 'open')

  // An open handoff card: find out if the bot's computer is off, so the card can say it starts first.
  useEffect(() => {
    if (!openHelp || $computerDemo.get()) {
      return
    }

    gateway
      .request<{ running?: boolean }>('display.status', { profile: bot.name })
      .then(result => setComputerOff(result?.running === false))
      .catch(() => setComputerOff(false))
  }, [openHelp, bot.name])
  const cards: ChatMsg[] = [
    ...askCards.map((card): ChatMsg => ({ id: card.id, role: 'assistant', text: '', at: card.at, ask: card })),
    ...secretCards.map((card): ChatMsg => ({ id: card.id, role: 'assistant', text: '', at: card.at, secret: card })),
    ...helpCards.map((card): ChatMsg => ({ id: card.id, role: 'assistant', text: '', at: card.at, help: card })),
    ...filePosts.map((post): ChatMsg => ({ id: post.id, role: 'assistant', text: post.caption || '', at: post.at, files: post.files, ...(post.thread ? { thread: post.thread } : {}) })),
    ...threadPosts.map((post): ChatMsg => ({ id: post.id, role: 'assistant', text: post.text, at: post.at, thread: post.root }))
  ].sort((a, b) => a.at - b.at)

  // Load this chat's saved cards and reactions (from this device) outside of render.
  useEffect(() => {
    chatCards(`bot:${bot.name}`)
    chatSecretCards(`bot:${bot.name}`)
    chatHelpCards(`bot:${bot.name}`)
    chatFilePosts(`bot:${bot.name}`)
    chatThreadPosts(`bot:${bot.name}`)
    loadChatReactions(`bot:${bot.name}`)
  }, [bot.name])
  // Device-local cards and approvals wait for Hermes's history, so reopening never flashes an old screen.
  const ready = chatShowsHistory(state)
  const waiting = outboxMessages(bot.name)
  const threaded = assignChatThreads([...(state?.messages || []), ...waiting])
  const rootIds = chatRootIds(threaded)
  const all = ready ? withCards(withChatReactions(`bot:${bot.name}`, withNotes(threaded, notes), reactions), cards) : waiting
  const split = splitThreads(all, msg => rootIds.get(msg.id))
  const messages = split.main
  const scope = `bot:${bot.name}`
  const threadOpen = openThread?.scope === scope ? openThread : null
  const threadRoot = threadOpen ? split.root(threadOpen.root) : undefined
  const onThread = (msg: ChatMsg) => msg.threadId && $openThread.set({ scope, root: msg.threadId })
  const chatProps = {
    botFor: (msg: ChatMsg) => (msg.from && msg.from !== bot.name ? null : bot),
    onReact: (msg: ChatMsg, emoji: string) => userReact({ kind: 'bot', name: bot.name }, msg, emoji),
    onAnswer: (msg: ChatMsg, picked: string[], custom: string) => msg.ask && userAnswer({ kind: 'bot', name: bot.name }, msg.ask, picked, custom),
    onSecretCancel: (card: Parameters<typeof userCancelSecret>[1]) => userCancelSecret(bot.name, card),
    onSecretSave: (card: Parameters<typeof userCancelSecret>[1], value: string) => userSaveSecret(bot.name, card, value),
    helpState: { activeId: handoff?.bot === bot.name ? handoff.card.id : undefined, computerOff },
    onHelpFail: (card: Parameters<typeof openHandoff>[1], reason: string) => finishHandoff(bot.name, card, false, reason),
    onHelpOpen: (card: Parameters<typeof openHandoff>[1]) => openHandoff(bot.name, card),
    scope
  }

  return (
    <section className="center" data-thread={threadRoot ? '' : undefined}>
      <MachineOffline bot={bot} />
      <TopBar
        onTitle={() => $panelOpen.set(!$panelOpen.get())}
        title={
          <>
            <Avatar badge={false} bot={bot} size={24} />
            <span>{bot.display}</span>
          </>
        }
      />
      <Thread
        approvals={ready ? approvals : []}
        {...chatProps}
        onThread={onThread}
        empty={
          !ready || state?.loading ? (
            <div className="thread-loading">
              <span className="spinner" />
            </div>
          ) : state?.error ? (
            <div className="hello">
              <Avatar bot={bot} size={72} />
              <h2>{bot.display}</h2>
              <p className="bad-text">{state.error}</p>
              <button className="btn" onClick={() => void loadBotChat(bot.name, true)} type="button">
                Try again
              </button>
            </div>
          ) : (
            <div className="hello">
              <Avatar bot={bot} float size={72} />
              <h2>{bot.display}</h2>
              <p>{bot.meta.description || bot.row.description || `Say hi to @${bot.handle}.`}</p>
              <div className="chips">
                {SUGGESTIONS.map(text => (
                  <button className="chip" key={text} onClick={() => void sendToBot(bot.name, text)} type="button">
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )
        }
        footer={runtime ? <PromptCards bot={() => bot} sessionIds={[runtime]} /> : null}
        messages={messages}
      />
      <BackgroundJobs bot={bot.name} session={runtime} />
      <Composer
        scope={scope}
        onSend={(text, attachments, opts) => void sendToBot(bot.name, text, attachments, opts)}
        onStop={() => void stopBot(bot.name)}
        voice={bot.name}
        placeholder={`Message ${bot.display}`}
        running={state?.running}
        thinking
        thinkingBot={bot.name}
        secretBot={{
          name: bot.name,
          display: bot.display,
          save: async (name, value) => {
            await saveSecret(bot.name, name, value)
            void sendToBot(bot.name, savedNote(name))
          }
        }}
      />
      {threadRoot && threadOpen ? (
        <ThreadPane title={bot.display}>
          <Thread {...chatProps} messages={[rootOnly(threadRoot), ...(split.threads.get(threadOpen.root) || [])]} />
          <Composer
            scope={scope}
            onSend={(text, attachments, opts) => void sendToBot(bot.name, text, attachments, { ...opts, thread: { root: threadOpen.root, text: threadRoot.text } })}
            onStop={() => void stopBot(bot.name)}
            voice={bot.name}
            placeholder="Reply in thread"
            running={state?.running}
          />
        </ThreadPane>
      ) : null}
    </section>
  )
}

const ago = (since: number, now: number) => {
  const s = Math.max(0, Math.round((now - since) / 1000))

  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const JOB_STATE: Record<Job['status'], string> = { queued: 'Waiting', running: '', done: 'Done', failed: 'Failed', stopped: 'Stopped' }

/** Helpers the bot handed work to: live, stoppable, and gone a moment after they finish. */
function BackgroundJobs({ bot, session }: { bot: string; session: string | null | undefined }) {
  const jobs = useStore($jobs)[bot] || []
  const [now, setNow] = useState(Date.now())
  const live = jobs.some(job => job.status === 'running' || job.status === 'queued')

  useEffect(() => {
    if (!live) {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [live])

  if (!jobs.length) {
    return null
  }

  return (
    <div className="jobs">
      {jobs.map(job => {
        const active = job.status === 'running' || job.status === 'queued'

        return (
          <div className="job" data-status={job.status} key={job.id}>
            {active ? <span className="spinner xs" /> : <Icon name={job.status === 'done' ? 'check' : 'close'} size={13} />}
            <span className="job-main">
              <b>{job.goal}</b>
              {job.note ? <small>{job.note}</small> : null}
            </span>
            <span className="job-meta">{JOB_STATE[job.status] || `${ago(job.startedAt, now)}${job.steps ? ` · ${job.steps} steps` : ''}`}</span>
            {active && session ? (
              <button className="job-stop" onClick={() => void stopJob(bot, session, job.id)} title="Stop this helper" type="button">
                Stop
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** The group whose Work pane is open, by room key. */
const $workRoom = atom<string | null>(null)

/** The Work button in a group's header: opens what the bots worked out loud before their answers. */
function WorkButton({ room }: { room: Room }) {
  const count = useStore($roomWork).filter(item => item.roomId === room.roomId).length
  const open = useStore($workRoom) === room.key

  return (
    <button
      aria-pressed={open}
      className="chip"
      onClick={() => {
        if (!open) $openThread.set(null)
        $workRoom.set(open ? null : room.key)
      }}
      title="What the bots worked out before their answers"
      type="button"
    >
      Work{count ? ` (${count})` : ''}
    </button>
  )
}

/** The Work pane: what each bot worked out loud in this group, per bot, newest first. Not the chat. */
function WorkPane({ room }: { room: Room }) {
  const work = useStore($roomWork).filter(item => item.roomId === room.roomId)
  const typing = useStore($roomTyping)[room.key] || {}
  const allBots = useStore($allBots)
  const close = () => $workRoom.set(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !event.defaultPrevented && $workRoom.set(null)

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const byBot = new Map<string, WorkItem[]>()

  for (const item of work) {
    byBot.set(item.member, [...(byBot.get(item.member) || []), item])
  }

  return (
    <aside className="thread-pane work-pane" aria-label="Work">
      <header className="thread-pane-head">
        <Icon name="thread" size={16} />
        <b>Work</b>
        <span className="thread-pane-sub">{room.name}</span>
        <button aria-label="Close work" className="icon-btn xs ghost" onClick={close} title="Close (Esc)" type="button">
          <Icon name="close" size={14} />
        </button>
      </header>
      {byBot.size === 0 ? <p className="work-empty">Nothing worked out loud yet. Progress from the bots shows here; their answers go to the chat.</p> : null}
      {[...byBot.entries()].map(([member, items]) => {
        const bot = allBots.find(candidate => candidate.name === member)

        return (
          <section className="work-bot" key={member}>
            <h4>
              {bot?.display || member}
              {typing[member] ? <small> · working now</small> : null}
            </h4>
            <ul>
              {items
                .slice()
                .reverse()
                .map(item => (
                  <li key={item.id}>
                    <time>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                    <span>{item.text}</span>
                  </li>
                ))}
            </ul>
          </section>
        )
      })}
    </aside>
  )
}

function roomMessages(room: Room, typing: RoomTypingTurn[]): ChatMsg[] {
  const base: ChatMsg[] = room.log.map(entry => ({
    id: entry.id,
    role: entry.from.kind === 'user' ? 'user' : 'assistant',
    text: entry.text,
    at: entry.at,
    from: entry.from.kind === 'member' ? entry.from.name : undefined,
    ...(entry.via ? { via: entry.via } : {}),
    ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
    ...(entry.reactions && Object.keys(entry.reactions).length ? { reactions: entry.reactions } : {}),
    ...(entry.ask ? { ask: entry.ask, text: '' } : {}),
    ...(entry.secretAsk ? { secretAsk: entry.secretAsk, text: '' } : {}),
    ...(entry.helpAsk ? { helpAsk: entry.helpAsk, text: '' } : {}),
    ...(entry.files?.length ? { files: entry.files } : {}),
    ...(entry.threadOf ? { thread: entry.threadOf } : {})
  }))

  // A bot still working shows as a typing line only. What it writes while it works is in Work.
  const live = typing.map(turn => ({
    id: `typing:${turn.member}`,
    role: 'assistant' as const,
    text: '',
    at: 0,
    from: turn.member,
    streaming: true,
    ...(turn.thread ? { thread: turn.thread } : {})
  }))

  return [...base, ...live]
}

export function RoomView({ room }: { room: Room }) {
  const typingAll = useStore($roomTyping)
  const running = useStore($roomRunning)
  const allBots = useStore($allBots)
  const lead = useStore($lead)
  const approvals = approvalsFor(useStore($approvals), `room:${room.roomId}`)
  const typing = Object.values(typingAll[room.key] || {})
  const members = roomBots(room)
  const leadHere = members.find(bot => bot.lead) || null
  const openThread = useStore($openThread)
  const workOpen = useStore($workRoom) === room.key
  const ids = new Set(room.log.map(entry => entry.id))
  const split = splitThreads(roomMessages(room, typing), msg => (ids.has(msg.id) ? msg.id : undefined))
  const roomNotes = useStore($switchNotes)[`room:${room.roomId}`] || []
  const messages = withNotes(split.main, roomNotes)
  const scope = `room:${room.roomId}`
  const threadOpen = openThread?.scope === scope ? openThread : null
  const threadRoot = threadOpen ? split.root(threadOpen.root) : undefined
  const byName = (name?: string) => allBots.find(bot => bot.name === name) || null
  const sessionIds = members.map(bot => runtimeFor(`room:${room.roomId}:${bot.name}`)).filter(Boolean) as string[]

  const starters = [
    leadHere ? `@${leadHere.handle} what should we work on today?` : 'What should we work on today?',
    'Introduce yourselves 👋',
    '@everyone status update?'
  ]

  return (
    <section className="center" data-thread={threadRoot ? '' : undefined}>
      <TopBar
        extra={
          <>
            {members.length ? <RoomModels members={members} roomId={room.roomId} /> : null}
            <WorkButton room={room} />
          </>
        }
        onTitle={() => $panelOpen.set(!$panelOpen.get())}
        title={
          <>
            <AvatarStack activity="global" bots={members} size={26} />
            <span>{room.name}</span>
          </>
        }
      />
      <Thread
        approvals={approvals}
        botFor={msg => byName(msg.from)}
        onReact={(msg, emoji) => userReact({ kind: 'room', key: room.key }, msg, emoji)}
        onAnswer={(msg, picked, custom) => msg.ask && userAnswer({ kind: 'room', key: room.key, asker: msg.from || '' }, msg.ask, picked, custom)}
        onThread={msg => msg.threadId && $openThread.set({ scope, root: msg.threadId })}
        empty={
          <div className="hello">
            <AvatarStack bots={members} size={72} />
            <h2>{room.name}</h2>
            <p>
              {leadHere
                ? `Say anything — ${leadHere.display} answers first and pulls in the right teammate.`
                : lead
                  ? 'Say anything — everyone here can chime in.'
                  : 'Say anything — everyone here can chime in. Pick a Lead to have one bot run the room.'}
              <br />
              @mention a bot to talk to it directly.
            </p>
            <div className="chips">
              {starters.map(text => (
                <button className="chip" key={text} onClick={() => postToRoom(room.key, text)} type="button">
                  {text}
                </button>
              ))}
            </div>
          </div>
        }
        footer={<PromptCards bot={sessionId => members.find(b => runtimeFor(`room:${room.roomId}:${b.name}`) === sessionId) || null} sessionIds={sessionIds} />}
        group
        messages={messages}
        scope={`room:${room.roomId}`}
      />
      {workOpen && !threadRoot ? <WorkPane room={room} /> : null}
      <HoldBanner members={members} room={room} />
      <Composer
        mentionables={members}
        scope={scope}
        onSend={(text, attachments, opts) => postToRoom(room.key, text, attachments, { answerTo: opts?.answerTo })}
        onStop={() => void stopRoom(room.key)}
        voice={members[0]?.name}
        placeholder={`Message ${room.name}`}
        running={running[room.key]}
      />
      {threadRoot && threadOpen ? (
        <ThreadPane title={room.name}>
          <Thread
            botFor={msg => byName(msg.from)}
            group
            messages={[rootOnly(threadRoot), ...(split.threads.get(threadOpen.root) || [])]}
            onAnswer={(msg, picked, custom) => msg.ask && userAnswer({ kind: 'room', key: room.key, asker: msg.from || '' }, msg.ask, picked, custom)}
            onReact={(msg, emoji) => userReact({ kind: 'room', key: room.key }, msg, emoji)}
            scope={scope}
          />
          <Composer
            mentionables={members}
            scope={scope}
            onSend={(text, attachments) => postToRoom(room.key, text, attachments, { threadOf: threadOpen.root })}
            onStop={() => void stopRoom(room.key)}
            voice={members[0]?.name}
            placeholder="Reply in thread"
            running={running[room.key]}
          />
        </ThreadPane>
      ) : null}
    </section>
  )
}

export function Welcome() {
  const bots = useStore($bots)

  return (
    <section className="center">
      <TopBar title={<span>NexurBots</span>} />
      <div className="hello welcome">
        {bots.length ? (
          <>
            <div className="welcome-faces">
              {bots.slice(0, 5).map((bot, i) => (
                <span key={bot.name} style={{ animationDelay: `${i * 90}ms` }}>
                  <Avatar bot={bot} float size={54} />
                </span>
              ))}
            </div>
            <h2>Pick a bot to chat</h2>
            <p>Or start a group and let your Lead run it.</p>
            <div className="chips">
              <button className="chip" onClick={() => $selection.set({ kind: 'bot', id: bots[0].name })} type="button">
                Chat with {bots[0].display}
              </button>
              {bots.length > 1 ? (
                <button className="chip" onClick={() => $dialog.set({ kind: 'room' })} type="button">
                  New group chat
                </button>
              ) : null}
              <button className="chip" onClick={() => $dialog.set({ kind: 'bot' })} type="button">
                New bot
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>No bots yet</h2>
            <p>Make your first bot — it gets its own memory, tools and personality.</p>
            <button className="btn primary" onClick={() => $dialog.set({ kind: 'bot' })} type="button">
              New bot
            </button>
          </>
        )}
      </div>
    </section>
  )
}

import { RoomModels } from './model-picker'
import { $switchNotes } from '../lib/session-model'
import { $machines, hostOf } from '../lib/hosts'

/** A bot whose machine is offline: say so above the chat. */
function MachineOffline({ bot }: { bot: Bot }) {
  const machine = useStore($machines).find(m => m.id === hostOf(bot.name))

  if (!machine || machine.state === 'online' || machine.main) return null

  return (
    <div className="machine-offline">
      <i className="machine-dot" /> {bot.display} runs on <b>{machine.label}</b>, which is {machine.state === 'connecting' ? 'connecting…' : 'offline'}. Messages can't reach it until it's back.
    </div>
  )
}
