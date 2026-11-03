import { afterEach, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'

const window = new Window({ url: 'http://localhost' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'MouseEvent', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : (window as any)[key] })
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const { Markdown } = await import('../src/ui/markdown')
const { Library } = await import('../src/ui/library')
const { $lightbox } = await import('../src/lib/lightbox')
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement

afterEach(async () => {
  await act(async () => { root?.unmount(); $lightbox.set(null) })
  host?.remove()
})

test('external pictures load only when the user chooses, and consent does not carry to a new URL', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const first = 'https://images.example.test/first.png'
  const second = 'https://other.example.test/second.png'
  await act(async () => root!.render(createElement(Markdown, { text: `![chart](${first})` })))
  expect(host.querySelector('img')).toBeNull()
  const load = host.querySelector('button.md-img-load') as HTMLButtonElement
  expect(load.textContent).toContain('images.example.test')
  await act(async () => load.click())
  expect(host.querySelector('img')?.getAttribute('src')).toBe(first)
  await act(async () => root!.render(createElement(Markdown, { text: `![chart](${second})` })))
  expect(host.querySelector('img')).toBeNull()
  expect(host.querySelector('button.md-img-load')?.textContent).toContain('other.example.test')
})

test('inline data pictures are displayed without a remote request', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(Markdown, { text: '![pixel](data:image/png;base64,aGVsbG8=)' })))
  expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=')
  expect(host.querySelector('button.md-img-load')).toBeNull()
})

test('the chat library does not prefetch remote images from messages', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const url = 'https://images.example.test/private.png'
  await act(async () => root!.render(createElement(Library, { scope: 'bot:remote-image-test', messages: [{ id: 'm1', role: 'assistant', text: `![chart](${url})`, at: 1 }] })))
  expect(host.querySelector('img')).toBeNull()
  const load = host.querySelector('button.lib-ghost') as HTMLButtonElement
  expect(load.textContent).toContain('Load external image')
  await act(async () => load.click())
  expect($lightbox.get()?.src).toBe(url)
})
