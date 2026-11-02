import { $searchPalette } from '../lib/search'
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { $approvals, $askingScopes } from '../lib/approvals'
import { $chats, type ChatState } from '../lib/chat'
import { disconnect } from '../lib/connection'
import { gateway } from '../lib/gateway'
import { $rooms, $roomRunning, $typingAll, clearRoom, compressRoomHistory, roomBots } from '../lib/rooms'
import { $active, $allBots, $busy, $lead, $bots, $query, $searchOpen, $selection, $userName, setLead, toast } from '../lib/store'
import type { Bot, ChatMsg, Room } from '../lib/types'
import { Avatar, AvatarStack } from './avatar'
import { openContextMenu } from './context-menu'
import { $dialog } from './dialogs'
import { Icon } from './icons'
import { Menu, type MenuItem } from './menu'

type Item = { kind: 'bot'; bot: Bot; at: number } | { kind: 'room'; room: Room; at: number }

const PASS = /^\s*[(\[]?\s*pass\s*[)\]]?\.?\s*$/i

function hasVisibleReply(messages: ChatMsg[]) {
  return messages.some(message => message.role === 'assistant' && message.text.trim().length > 0 && !PASS.test(message.text))
}

function isBotStreaming(chat: ChatState | undefined) {
  return Boolean(chat?.running && chat.messages.some(message => message.streaming && hasVisibleReply([message])))
}

function matches(text: string, query: string) {
  return text.toLowerCase().includes(query.toLowerCase())
}

function botMenuItems(bot: Bot): (MenuItem | 'sep')[] {
  const items: (MenuItem | 'sep')[] = [
    { icon: 'edit', label: 'Edit bot', onSelect: () => $dialog.set({ kind: 'bot', name: bot.name }) },
    {
      icon: 'star',
      label: bot.lead ? 'Remove as Lead' : 'Set as Lead',
      onSelect: () =>
        void setLead(bot.lead ? null : bot.name)
          .then(() => toast(bot.lead ? `${bot.display} is no longer the Lead` : `${bot.display} is now the Lead`))
          .catch(error => toast(String(error.message || error), 'bad'))
    }
  ]

  items.push(
    'sep',
    { icon: 'download', label: 'Export as template', onSelect: () => $dialog.set({ kind: 'export-template', name: bot.name }) },
    { icon: 'copy', label: 'Duplicate bot', onSelect: () => void duplicateBot(bot.name) }
  )

  if (bot.name !== 'default') {
    items.push('sep', { icon: 'trash', label: 'Delete bot', danger: true, onSelect: () => $dialog.set({ kind: 'delete-bot', name: bot.name }) })
  }

  return items
}

function roomMenuItems(room: Room): (MenuItem | 'sep')[] {
  return [
    { icon: 'edit', label: 'Edit group', onSelect: () => $dialog.set({ kind: 'room', key: room.key }) },
    {
      icon: 'refresh',
      label: 'Compress history',
      onSelect: () => {
        toast('Compressing each bot’s history — this can take a few minutes…')
        void compressRoomHistory(room.key).then(outcome => {
          const parts: string[] = []

          if (outcome.compressed) {
            parts.push(`${outcome.compressed} compressed`)
          }

          if (outcome.pending) {
            parts.push(`${outcome.pending} still working`)
          }

          if (outcome.skipped) {
            parts.push(`${outcome.skipped} skipped`)
          }

          toast(parts.length ? parts.join(', ') : 'Nothing to compress', outcome.compressed ? 'good' : undefined)
        })
      }
    },
    {
      icon: 'close',
      label: 'Clear messages',
      onSelect: () => {
        clearRoom(room.key)
        toast('Messages cleared')
      }
    },
    'sep',
    { icon: 'trash', label: 'Delete group', danger: true, onSelect: () => $dialog.set({ kind: 'delete-room', key: room.key }) }
  ]
}

/** A small amber line on a roster row while a bot waits for your OK. */
function AskLine({ text }: { text: string }) {
  return (
    <span className="row-preview" data-ask>
      <Icon name="shield" size={12} />
      {text}
    </span>
  )
}

/** Says so when a bot in a chat you are not looking at asks for approval. */
function useAskToasts() {
  const approvals = useStore($approvals)
  const seen = useRef<Set<string> | null>(null)

  useEffect(() => {
    const pending = approvals.filter(a => a.status === 'pending')

    if (!seen.current) {
      seen.current = new Set(pending.map(a => a.id))

      return
    }

    const selection = $selection.get()
    const viewing =
      selection?.kind === 'bot' ? `bot:${selection.id}` : selection?.kind === 'room' ? `room:${$rooms.get()[selection.id]?.roomId || ''}` : ''

    for (const card of pending) {
      if (!seen.current.has(card.id)) {
        seen.current.add(card.id)

        if (card.scope !== viewing) {
          const who = $allBots.get().find(bot => bot.name === card.bot)?.display || card.bot
          toast(`${who} needs your OK`)
        }
      }
    }
  }, [approvals])
}

export function Roster() {
  useAskToasts()
  const asking = useStore($askingScopes)
  const bots = useStore($bots)
  const lead = useStore($lead)
  const rooms = useStore($rooms)
  const busy = useStore($busy)
  const chats = useStore($chats)
  const roomRunning = useStore($roomRunning)
  const selection = useStore($selection)
  const query = useStore($query)
  const machines = useStore($machines)
  const grouped = useStore($groupByMachine) && machines.length > 1

  const items = useMemo(() => {
    const list: Item[] = [
      ...Object.values(rooms).map(room => ({ kind: 'room' as const, room, at: room.log.at(-1)?.at || 0 })),
      ...bots.filter(bot => !lead || bot.name !== lead.name).map(bot => ({ kind: 'bot' as const, bot, at: bot.lastActive }))
    ]

    const q = query.trim()
    const filtered = q
      ? list.filter(item =>
          item.kind === 'bot'
            ? matches(item.bot.display, q) || matches(item.bot.handle, q) || matches(item.bot.preview, q)
            : matches(item.room.name, q) || roomBots(item.room).some(bot => matches(bot.display, q))
        )
      : list

    return filtered.sort((a, b) => b.at - a.at)
  }, [bots, lead, rooms, query])

  const leadVisible = lead && (!query.trim() || matches(lead.display, query.trim()) || matches(lead.handle, query.trim()))

  return (
    <aside className="roster">
      <div className="roster-top">
        {(
          <>
            <div className="drag-fill" />
            <button aria-label="Search (Ctrl+K)" className="icon-btn" onClick={() => $searchPalette.set(true)} title="Search all chats (Ctrl+K)" type="button">
              <Icon name="search" />
            </button>
            <Menu
              align="start"
              items={[
                { icon: 'bot', label: 'New bot', onSelect: () => $dialog.set({ kind: 'bot' }) },
                {
                  icon: 'users',
                  label: 'New group chat',
                  disabled: bots.length < 2,
                  onSelect: () => $dialog.set({ kind: 'room' })
                },
                'sep',
                { icon: 'users', label: 'Team', onSelect: () => $dialog.set({ kind: 'team' }) },
                { icon: 'memory', label: 'Shared memory', onSelect: () => $dialog.set({ kind: 'memory' }) },
                { icon: 'folder', label: 'Shared folder', onSelect: () => $dialog.set({ kind: 'folder' }) }
              ]}
              trigger={
                <button aria-label="New" className="icon-btn" type="button">
                  <Icon name="plus" />
                </button>
              }
            />
          </>
        )}
      </div>

      <div className="roster-scroll">
        {leadVisible && lead ? (
          <button
            className="lead"
            data-on={selection?.kind === 'bot' && selection.id === lead.name ? true : undefined}
            onClick={() => $selection.set({ kind: 'bot', id: lead.name })}
            type="button"
          >
            <Avatar activity="global" bot={lead} float size={58} />
            <span className="lead-name">{lead.display}</span>
            {asking[`bot:${lead.name}`] ? <AskLine text="Needs your OK" /> : null}
          </button>
        ) : !lead && bots.length >= 2 && !query ? (
          <button className="lead-empty" onClick={() => $dialog.set({ kind: 'lead' })} type="button">
            <span className="lead-empty-faces">
              {bots.slice(0, 3).map(bot => (
                <Avatar badge={false} bot={bot} key={bot.name} size={30} />
              ))}
            </span>
            <b>Pick a Lead</b>
            <small>The Lead answers first in groups and hands work to the team.</small>
          </button>
        ) : null}

        <div className="list">
          {(grouped ? groupItems(items, machines) : items).map((item, index) =>
            item.kind === 'head' ? (
              <div className="list-head" data-state={item.state} key={`h:${item.id}`}>
                <i className="machine-dot" />
                {item.label}
              </div>
            ) :
            item.kind === 'bot' ? (
              <BotRow asking={!!asking[`bot:${item.bot.name}`]} bot={item.bot} busy={Boolean(Object.prototype.hasOwnProperty.call(busy, item.bot.name) && busy[item.bot.name])} index={index} key={`b:${item.bot.name}`} on={selection?.kind === 'bot' && selection.id === item.bot.name} streaming={isBotStreaming(chats[item.bot.name])} />
            ) : (
              <RoomRow index={index} key={`r:${item.room.key}`} on={selection?.kind === 'room' && selection.id === item.room.key} room={item.room} running={Boolean(roomRunning[item.room.key])} />
            )
          )}
          {!items.length && !leadVisible ? (
            <div className="list-empty">{query ? 'No matches' : bots.length ? 'No other bots yet' : 'No bots yet — make one with +'}</div>
          ) : null}
        </div>
      </div>

      <RosterFoot />
    </aside>
  )
}

function RoomRow({ room, on, running, index }: { room: Room; on: boolean; running: boolean; index: number }) {
  const members = roomBots(room)
  const asks = useStore($askingScopes)[`room:${room.roomId}`] || []
  const typing = useStore($typingAll)[room.key] || {}
  const asker = asks.length ? members.find(bot => bot.name === asks[0].bot)?.display || asks[0].bot : ''
  const streaming = Object.values(typing).some(turn => hasVisibleReply(turn.messages))

  return (
    <button
      className="row"
      data-on={on || undefined}
      onClick={() => $selection.set({ kind: 'room', id: room.key })}
      onContextMenu={event => openContextMenu(event, roomMenuItems(room))}
      style={{ animationDelay: `${index * 22}ms` }}
      type="button"
    >
      <AvatarStack activity="global" bots={members} size={38} />
      <span className="row-main">
        <span className="row-name">{room.name}</span>
        {asker ? (
          <AskLine text={`${asker} needs your OK`} />
        ) : running ? (
          <span className="row-preview" data-typing={streaming || undefined} data-working={!streaming || undefined}>
            {streaming ? 'typing…' : 'working'}
          </span>
        ) : null}
      </span>
      <button aria-label={`Options for ${room.name}`} className="icon-btn xs ghost row-kebab" onClick={event => openContextMenu(event, roomMenuItems(room))} type="button">
        <Icon name="more" size={14} />
      </button>
    </button>
  )
}

type Listed = Item | { kind: 'head'; id: string; label: string; state: MachineView['state'] }

/** Group by machine: group chats first, then each machine's bots under its name. */
function groupItems(items: Item[], machines: MachineView[]): Listed[] {
  const out: Listed[] = items.filter(item => item.kind === 'room')

  for (const m of machines) {
    const mine = items.filter(item => item.kind === 'bot' && hostOf(item.bot.name) === m.id)
    if (mine.length) out.push({ kind: 'head', id: m.id || 'main', label: m.label, state: m.state }, ...mine)
  }

  return out
}

function BotRow({ bot, on, asking, busy, index, streaming }: { bot: Bot; on: boolean; asking: boolean; busy: boolean; index: number; streaming: boolean }) {
  const machines = useStore($machines)
  const grouped = useStore($groupByMachine)
  const host = hostOf(bot.name)
  const machine = machines.find(m => m.id === host)
  const offline = machine ? machine.state !== 'online' : false

  return (
    <button
      className="row"
      data-offline={offline || undefined}
      data-on={on || undefined}
      onClick={() => $selection.set({ kind: 'bot', id: bot.name })}
      onContextMenu={event => openContextMenu(event, botMenuItems(bot))}
      style={{ animationDelay: `${index * 22}ms` }}
      title={offline ? `${machine?.label} is offline` : undefined}
      type="button"
    >
      <Avatar activity="global" bot={bot} size={38} />
      <span className="row-main">
        <span className="row-name">
          {bot.display}
          {machines.length > 1 && machine && !grouped ? <span className="host-badge" title={`Runs on ${machine.label}`}>{machine.label}</span> : null}
        </span>
        {offline ? (
          <span className="row-preview">{machine?.state === 'connecting' ? 'machine connecting…' : 'machine offline'}</span>
        ) : asking ? (
          <AskLine text="Needs your OK" />
        ) : busy ? (
          <span className="row-preview" data-typing={streaming || undefined} data-working={!streaming || undefined}>
            {streaming ? 'typing…' : 'working'}
          </span>
        ) : null}
      </span>
      <button aria-label={`Options for ${bot.display}`} className="icon-btn xs ghost row-kebab" onClick={event => openContextMenu(event, botMenuItems(bot))} type="button">
        <Icon name="more" size={14} />
      </button>
    </button>
  )
}

function RosterFoot() {
  const active = useStore($active)
  const live = useStore(gateway.state)
  const user = useStore($userName)
  const [, force] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => force(n => n + 1), 5000)

    return () => clearInterval(timer)
  }, [])

  const machines = useStore($machines)
  const grouped = useStore($groupByMachine)
  const many = machines.length > 1
  // Design previews have machines but no socket: show the main machine's state.
  const state = isMachinesPreview() && many ? (machines[0].state === 'online' ? 'open' : 'closed') : live
  const down = machines.filter(m => m.state !== 'online').length
  const tone = state === 'open' ? (many && down ? 'warn' : 'ok') : state === 'closed' ? 'bad' : 'warn'

  return (
    <div className="roster-foot">
      <button aria-label="Settings" className="me" onClick={() => $dialog.set({ kind: 'settings' })} type="button">
        {(user || 'Y').trim().charAt(0).toUpperCase()}
      </button>
      <Menu
        items={[
          ...(state === 'reconnecting' ? [{ icon: 'refresh' as const, label: 'Reconnect now', onSelect: () => gateway.retryNow() }] : []),
          ...(many
            ? [
                ...machines.map(m => ({ icon: (m.state === 'online' ? 'check' : 'close') as IconName, label: `${m.label} · ${m.state === 'online' ? 'online' : m.state === 'connecting' ? 'connecting' : 'offline'}`, onSelect: () => $dialog.set({ kind: 'settings' }) })),
                { icon: 'users' as const, label: grouped ? 'Stop grouping by machine' : 'Group bots by machine', onSelect: () => setGroupByMachine(!grouped) },
                'sep' as const
              ]
            : []),
          { icon: 'settings', label: 'Settings', onSelect: () => $dialog.set({ kind: 'settings' }) },
          'sep',
          { icon: 'logout', label: 'Log out', danger: true, onSelect: () => void disconnect() }
        ]}
        trigger={
          <button className="conn-pill" type="button">
            <i className="dot" data-tone={tone} />
            <span>
              {state === 'open'
                ? many
                  ? `${machines.length} machines`
                  : active?.label || 'Connected'
                : state === 'reconnecting'
                  ? 'Reconnecting…'
                  : 'Offline'}
            </span>
            <Icon name={active?.kind === 'local' ? 'computer' : active?.kind === 'ssh' ? 'server' : 'globe'} size={15} />
          </button>
        }
      />
    </div>
  )
}

import { duplicateBot } from './templates'
import { $groupByMachine, $machines, hostOf, isMachinesPreview, setGroupByMachine, type MachineView } from '../lib/hosts'
import type { IconName } from './icons'
