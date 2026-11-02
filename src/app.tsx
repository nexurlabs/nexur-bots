import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import { $chats, runtimeFor } from './lib/chat'
import { demo } from './demo'
import { boot } from './lib/connection'
import { gateway } from './lib/gateway'
import { $rooms, loadRooms, watchLive } from './lib/rooms'
import { $bots, $panelOpen, $phase, $profiles, $selection, $toast, refreshProfiles } from './lib/store'
import { ConnectScreen } from './ui/connect'
import { ProviderNotice } from './ui/provider-notice'
import { ContextMenuHost } from './ui/context-menu'
import { Dialogs } from './ui/dialogs'
import { Panel } from './ui/panel'
import { ReconnectBar } from './ui/reconnect'
import { Roster } from './ui/roster'
import { Lightbox, OrphanPrompts } from './ui/thread'
import { BotChatView, RoomView, Welcome } from './ui/views'

function Center() {
  const selection = useStore($selection)
  const bots = useStore($bots)
  const rooms = useStore($rooms)

  if (selection?.kind === 'room' && rooms[selection.id]) {
    return <RoomView room={rooms[selection.id]} />
  }

  const bot = selection?.kind === 'bot' ? bots.find(b => b.name === selection.id) : null

  return bot ? <BotChatView bot={bot} key={bot.name} /> : <Welcome />
}

function Shell() {
  const panelOpen = useStore($panelOpen)
  const state = useStore(gateway.state)
  const chats = useStore($chats)
  const rooms = useStore($rooms)
  const profiles = useStore($profiles)

  // Keep previews and rooms fresh.
  useEffect(() => {
    const timer = setInterval(() => {
      if (gateway.state.get() === 'open') {
        void refreshProfiles()
          .then(() => loadRooms())
          .catch(() => undefined)
      }
    }, 20_000)

    return () => clearInterval(timer)
  }, [])

  // The turns the runner is running show here as they happen.
  useEffect(() => watchLive(), [])

  useEffect(() => {
    loadRooms()
  }, [profiles])

  const known = [
    ...Object.keys(chats).map(name => runtimeFor(`bot:${name}`)),
    ...Object.values(rooms).flatMap(room => room.members.map(m => runtimeFor(`room:${room.roomId}:${m.name}`)))
  ].filter(Boolean) as string[]

  return (
    <div className="shell" data-panel={panelOpen || undefined}>
      <Roster />
      <Center />
      <Panel />
      <OrphanPrompts known={known} />
      <ReconnectBar />
    </div>
  )
}

function Toast() {
  const toast = useStore($toast)

  return toast ? (
    <div className="toast" data-tone={toast.tone} key={toast.id}>
      {toast.text}
    </div>
  ) : null
}

function App() {
  const phase = useStore($phase)

  useEffect(() => {
    const view = location.hash.replace('#', '')

    if (view && !window.native) {
      demo(view)

      return
    }

    void boot()
  }, [])

  return (
    <>
      {phase === 'app' ? <Shell /> : <ConnectScreen />}
      <Dialogs />
      {phase === 'app' ? <ProviderNotice /> : null}
      <Toast />
      <ContextMenuHost />
      <Lightbox />
      <SearchPalette />
    </>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)

import { SearchPalette } from './ui/search-palette'
import './lib/event-routines'
import { installTemplateDrop } from './ui/templates'
installTemplateDrop()
