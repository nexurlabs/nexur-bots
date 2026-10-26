import { afterEach, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatMsg, Room, RoomEntry } from '../src/lib/types'

const { RoomView } = await import('../src/ui/views')
const { $roomRunning, $roomTyping, $rooms } = await import('../src/lib/rooms')
const { $openThread } = await import('../src/lib/threads')
const { $profiles } = await import('../src/lib/store')

const key = 'id:parallel-typing-ui'
const room: Room = {
  key,
  name: 'Parallel typing',
  roomId: 'parallel-typing-ui',
  members: [{ name: 'alpha', handle: 'alpha' }, { name: 'beta', handle: 'beta' }],
  log: []
}

afterEach(() => {
  $roomTyping.set({})
  $roomRunning.set({})
  $rooms.set({})
  $openThread.set(null)
  $profiles.set([])
})

// A working bot shows as a typing bubble. What it writes while it works stays out of the chat:
// progress goes to Work, and the answer is posted only when its turn ends.
describe('room typing UI', () => {
  test('renders a typing bubble for every concurrently typing bot, without their partial text', () => {
    $profiles.set([
      { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha' } } },
      { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
    ] as any)
    $rooms.set({ [key]: room })

    const alpha: ChatMsg = { id: 'alpha-stream', role: 'assistant', text: 'alpha partial answer', at: 1, from: 'alpha', streaming: true }
    const beta: ChatMsg = { id: 'beta-stream', role: 'assistant', text: 'beta partial answer', at: 2, from: 'beta', streaming: true }
    $roomTyping.set({
      [key]: {
        alpha: { member: 'alpha', messages: [alpha] },
        beta: { member: 'beta', messages: [beta] }
      }
    })

    const html = renderToStaticMarkup(createElement(RoomView, { room }))

    expect(html).not.toContain('alpha partial answer')
    expect(html).not.toContain('beta partial answer')
    expect((html.match(/class="bubble typing"/g) || []).length).toBe(2)
    expect((html.match(/class="msg bot"/g) || []).length).toBe(2)
  })

  test('shows a typing bubble for a bot that has not written yet, and one for a bot that has', () => {
    $profiles.set([
      { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha' } } },
      { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
    ] as any)
    $rooms.set({ [key]: room })

    const beta: ChatMsg = { id: 'beta-stream', role: 'assistant', text: 'beta partial answer', at: 2, from: 'beta', streaming: true }
    $roomTyping.set({
      [key]: {
        alpha: { member: 'alpha', messages: [] },
        beta: { member: 'beta', messages: [beta] }
      }
    })

    const html = renderToStaticMarkup(createElement(RoomView, { room }))

    expect((html.match(/class="bubble typing"/g) || []).length).toBe(2)
    expect(html).not.toContain('beta partial answer')
    expect((html.match(/class="msg bot"/g) || []).length).toBe(2)
  })

  test('keeps concurrent typing bubbles inside their open thread, without their partial text', () => {
    $profiles.set([
      { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha' } } },
      { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
    ] as any)
    const root: RoomEntry = { id: 'thread-root', at: 1, from: { kind: 'member', name: 'alpha' }, text: 'thread topic' }
    const threadedRoom = { ...room, log: [root] }
    $rooms.set({ [key]: threadedRoom })
    $openThread.set({ scope: `room:${room.roomId}`, root: root.id })

    const alpha: ChatMsg = { id: 'alpha-thread-stream', role: 'assistant', text: 'alpha thread reply', at: 2, from: 'alpha', streaming: true }
    const beta: ChatMsg = { id: 'beta-thread-stream', role: 'assistant', text: 'beta thread reply', at: 3, from: 'beta', streaming: true }
    $roomTyping.set({
      [key]: {
        alpha: { member: 'alpha', messages: [alpha], thread: root.id },
        beta: { member: 'beta', messages: [beta], thread: root.id }
      }
    })

    const html = renderToStaticMarkup(createElement(RoomView, { room: threadedRoom }))

    expect(html).not.toContain('alpha thread reply')
    expect(html).not.toContain('beta thread reply')
    expect((html.match(/class="bubble typing"/g) || []).length).toBe(2)
    expect(html).toContain('thread topic')
  })

  test('keeps a typing bubble in a thread for a bot that has not written yet, beside another member\'s', () => {
    $profiles.set([
      { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha' } } },
      { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
    ] as any)
    const root: RoomEntry = { id: 'thread-root', at: 1, from: { kind: 'member', name: 'alpha' }, text: 'thread topic' }
    const threadedRoom = { ...room, log: [root] }
    $rooms.set({ [key]: threadedRoom })
    $openThread.set({ scope: `room:${room.roomId}`, root: root.id })

    const beta: ChatMsg = { id: 'beta-thread-stream', role: 'assistant', text: 'beta thread reply', at: 3, from: 'beta', streaming: true }
    $roomTyping.set({
      [key]: {
        alpha: { member: 'alpha', messages: [], thread: root.id },
        beta: { member: 'beta', messages: [beta], thread: root.id }
      }
    })

    const html = renderToStaticMarkup(createElement(RoomView, { room: threadedRoom }))

    expect((html.match(/class="bubble typing"/g) || []).length).toBe(2)
    expect(html).not.toContain('beta thread reply')
  })

  test('keeps the other typing bubble when one member finishes, and posts the finished answer', () => {
    $profiles.set([
      { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha' } } },
      { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
    ] as any)
    const alphaAnswer: RoomEntry = { id: 'alpha-answer', at: 1, from: { kind: 'member', name: 'alpha' }, text: 'alpha finished' }
    $rooms.set({ [key]: { ...room, log: [alphaAnswer] } })

    const beta: ChatMsg = { id: 'beta-stream', role: 'assistant', text: 'beta still streaming', at: 2, from: 'beta', streaming: true }

    // Alpha's live turn is gone after completion; beta is still working.
    $roomTyping.set({ [key]: { beta: { member: 'beta', messages: [beta] } } })
    const html = renderToStaticMarkup(createElement(RoomView, { room: { ...room, log: [alphaAnswer] } }))

    expect(html).toContain('alpha finished')
    expect(html).not.toContain('beta still streaming')
    expect((html.match(/class="bubble typing"/g) || []).length).toBe(1)
    expect((html.match(/class="msg bot"/g) || []).length).toBe(2)
  })
})
