/**
 * Library tab: everything shared in a chat, sorted by kind. Pictures and files the person sent come
 * from the local copies kept on this device (so they can be previewed and saved again); anything
 * Hermes mentioned in text — image URLs and links — is picked out of the conversation itself.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { $library, downloadAttachment, humanSize, type LibraryItem, loadLibrary, removeFromLibrary } from '../lib/attachments'
import { native } from '../lib/native'
import { toast } from '../lib/store'
import type { ChatMsg } from '../lib/types'
import { openContextMenu } from './context-menu'
import { Icon } from './icons'
import { FileGlyph, openImage } from './thread'

type Filter = 'all' | 'files' | 'images' | 'links'

interface Shared {
  key: string
  kind: 'file' | 'image'
  name: string
  at: number
  size?: number
  thumb?: string
  /** The copy on this device; absent for things sent from another device or before this feature. */
  local?: LibraryItem
}

interface Pic {
  key: string
  name: string
  at: number
  src?: string
  local?: LibraryItem
}

const IMAGE_URL = /\.(png|jpe?g|gif|webp|svg)(\?|$)/i
const imageHost = (src: string) => {
  try { return new URL(src).host || 'external site' } catch { return 'external site' }
}

const day = (at: number) => new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })

const lastSegment = (url: string) => decodeURIComponent(url.replace(/[?#].*$/, '').split('/').pop() || url)

function collect(messages: ChatMsg[], local: LibraryItem[], scope: string) {
  const sent = new Map<string, Shared>()
  const known = new Set(local.map(item => item.ref || item.name))

  for (const item of local) {
    sent.set(item.id, { key: item.id, kind: item.kind, name: item.name, at: item.at, size: item.size, thumb: item.thumb, local: item })
  }

  const images = new Set<string>()
  const links = new Set<string>()

  for (const msg of messages) {
    // Things that were sent but whose local copy is gone (another device, cleared storage).
    for (const att of msg.attachments || []) {
      const ref = att.ref || att.name

      if (known.has(ref) || sent.has(`${scope}|${att.id}`)) {
        continue
      }

      known.add(ref)
      sent.set(`history|${ref}`, { key: `history|${ref}`, kind: att.kind, name: att.name, at: msg.at, size: att.size, thumb: att.thumb })
    }

    for (const match of msg.text.matchAll(/!\[[^\]]*\]\((https?:[^)\s]+|data:image[^)\s]+)\)/g)) {
      images.add(match[1])
    }

    for (const match of msg.text.matchAll(/https?:\/\/[^\s<>()\]]+[^\s<>().,;:!?'"\]]/g)) {
      ;(IMAGE_URL.test(match[0]) ? images : links).add(match[0])
    }
  }

  const everything = [...sent.values()].sort((a, b) => b.at - a.at)

  const pics: Pic[] = [
    ...everything.filter(item => item.kind === 'image').map(item => ({ key: item.key, name: item.name, at: item.at, src: item.thumb, local: item.local })),
    ...[...images].reverse().map(src => ({ key: src, name: lastSegment(src), at: 0, src }))
  ]

  return { pics, files: everything.filter(item => item.kind === 'file'), links: [...links].reverse() }
}

export function Library({ messages, scope }: { messages: ChatMsg[]; scope: string }) {
  const stored = useStore($library)
  const [filter, setFilter] = useState<Filter>('all')
  const local = stored[scope]

  useEffect(() => {
    void loadLibrary(scope)
  }, [scope])

  const { pics, files, links } = useMemo(() => collect(messages, local || [], scope), [messages, local, scope])
  const total = pics.length + files.length + links.length

  const save = (item: LibraryItem) =>
    void downloadAttachment(item).then(res => (res === 'saved' ? toast(`Saved ${item.name}`) : res === 'missing' ? toast('That file is no longer on this device', 'bad') : undefined))

  const remove = (item: LibraryItem) => void removeFromLibrary(scope, item.id).then(() => toast('Removed from this device'))

  const menuFor = (local?: LibraryItem) =>
    local
      ? [
          { icon: 'file' as const, label: 'Save a copy', onSelect: () => save(local) },
          { icon: 'trash' as const, label: 'Remove from this device', danger: true, onSelect: () => remove(local) }
        ]
      : []

  if (!total) {
    return (
      <div className="panel-empty">
        Pictures and files you send, and links and images in the replies, collect here. Drop a file into the chat or use the + button to add one.
      </div>
    )
  }

  const counts: [Filter, string, number][] = [
    ['all', 'All', total],
    ['images', 'Images', pics.length],
    ['files', 'Files', files.length],
    ['links', 'Links', links.length]
  ]

  const show = (kind: Exclude<Filter, 'all'>) => filter === 'all' || filter === kind

  return (
    <div>
      <div className="lib-filters">
        {counts
          .filter(([id, , count]) => id === 'all' || count > 0)
          .map(([id, label, count]) => (
            <button data-on={filter === id || undefined} key={id} onClick={() => setFilter(id)} type="button">
              {label}
              <small>{count}</small>
            </button>
          ))}
      </div>
      {show('images') && pics.length ? (
        <section className="lib-section">
          {filter === 'all' ? <b>Images</b> : null}
          <div className="lib-grid">
            {pics.map(pic =>
              pic.src && /^https?:/i.test(pic.src) ? (
                <button className="lib-ghost" key={pic.key} onClick={() => void openImage(pic, undefined, pic.src)} title={`Load image from ${imageHost(pic.src)}`} type="button">
                  <Icon name="image" size={20} />
                  <small>Load external image from {imageHost(pic.src)}</small>
                </button>
              ) : pic.src ? (
                <button
                  key={pic.key}
                  onClick={() => void openImage(pic, pic.local, pic.src)}
                  onContextMenu={event => pic.local && openContextMenu(event, menuFor(pic.local))}
                  title={pic.name}
                  type="button"
                >
                  <img alt={pic.name} src={pic.src} />
                </button>
              ) : (
                <div className="lib-ghost" key={pic.key} title="Sent earlier — no preview on this device">
                  <Icon name="image" size={20} />
                  <small>{pic.name}</small>
                </div>
              )
            )}
          </div>
        </section>
      ) : null}
      {show('files') && files.length ? (
        <section className="lib-section">
          {filter === 'all' ? <b>Files</b> : null}
          {files.map(file => (
            <div className="lib-file" key={file.key} onContextMenu={event => file.local && openContextMenu(event, menuFor(file.local))}>
              <FileGlyph name={file.name} />
              <span className="txt">
                <b title={file.name}>{file.name}</b>
                <small>{[file.size ? humanSize(file.size) : '', day(file.at), file.local ? '' : 'Not on this device'].filter(Boolean).join(' · ')}</small>
              </span>
              {file.local ? (
                <span className="acts">
                  <button aria-label={`Save ${file.name}`} className="icon-btn xs ghost" onClick={() => file.local && save(file.local)} title="Save a copy" type="button">
                    <Icon name="download" size={13} />
                  </button>
                  <button aria-label={`Remove ${file.name}`} className="icon-btn xs ghost" onClick={() => file.local && remove(file.local)} title="Remove from this device" type="button">
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {show('links') && links.length ? (
        <section className="lib-section">
          {filter === 'all' ? <b>Links</b> : null}
          {links.map(href => (
            <button className="lib-link" key={href} onClick={() => void native.openExternal(href)} type="button">
              <Icon name="link" size={15} />
              <span>{href.replace(/^https?:\/\//, '')}</span>
            </button>
          ))}
        </section>
      ) : null}
      {files.length || pics.some(pic => pic.local) ? (
        <p className="lib-note">Files you send are kept on this device so you can open them again. Hermes keeps its own copy in the bot's workspace.</p>
      ) : null}
    </div>
  )
}
