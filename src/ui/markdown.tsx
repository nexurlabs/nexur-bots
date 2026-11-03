/**
 * Markdown in chat bubbles. `marked` turns the text into GitHub-flavoured Markdown tokens, and
 * this file turns those tokens into React elements itself, so raw HTML in a reply is shown as
 * text and never becomes markup. The two exceptions are generated markup: highlight.js's
 * `<span class="hljs-…">` for code and KaTeX's output for math (`trust: false`); both escape the
 * text they're given.
 *
 * Links open in the system browser (http, https and mailto only), never in the app window.
 * Mid-stream, a half-written table or formula is held back until it can be drawn whole; an
 * unclosed code fence is simply a code block that is still growing.
 */
import { useStore } from '@nanostores/react'
import { Marked, type Token, type Tokens, type TokenizerExtension } from 'marked'
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'

import { highlight, languageLabel } from '../lib/highlight'
import { $lightbox } from '../lib/lightbox'
import { $katex, loadKatex, renderMath } from '../lib/math'
import { native } from '../lib/native'
import { readHermesImage } from '../lib/shared-folder'
import { Icon } from './icons'

// ── parsing ───────────────────────────────────────────────────────────────
/** `$$…$$` and `\[…\]` on their own lines: display math. */
const blockMath: TokenizerExtension = {
  name: 'mathBlock',
  level: 'block',
  start: src => src.match(/^ {0,3}(\$\$|\\\[)/m)?.index,
  tokenizer(src) {
    const match = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(src)

    return match ? { type: 'mathBlock', raw: match[0], text: (match[1] ?? match[2]).trim() } : undefined
  }
}

/** `\(…\)` inline, and `$$…$$` inside a sentence (shown as display math). Single `$` stays text: it's usually money. */
const inlineMath: TokenizerExtension = {
  name: 'mathInline',
  level: 'inline',
  start: src => src.match(/\\\(|\$\$/)?.index,
  tokenizer(src) {
    const match = /^(?:\\\(([\s\S]+?)\\\)|\$\$([^$]+?)\$\$)/.exec(src)

    return match ? { type: 'mathInline', raw: match[0], text: (match[1] ?? match[2]).trim(), display: match[2] !== undefined } : undefined
  }
}

const parser = new Marked({ gfm: true, breaks: true, extensions: [blockMath, inlineMath] })

/**
 * While a reply is still arriving, hold back what would flash as raw text and then jump: a table
 * whose header has no `|---|` line under it yet, and a formula whose closing `$$` hasn't come.
 */
export function steady(text: string): string {
  let out = text
  const fences = (out.match(/^ {0,3}(```|~~~)/gm) || []).length

  if (fences % 2 === 0) {
    // Outside code, an odd number of $$ means a formula is still open.
    const outside = out.replace(/^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1.*$/gm, '')

    if (((outside.match(/\$\$/g) || []).length) % 2 === 1) {
      out = out.slice(0, out.lastIndexOf('$$'))
    }

    const lines = out.split('\n')
    let start = lines.length

    while (start > 0 && /^\s*\|/.test(lines[start - 1])) {
      start--
    }

    const tail = lines.slice(start)

    if (tail.length && !tail.some(line => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line))) {
      out = lines.slice(0, start).join('\n')
    } else if (tail.length && !/\|\s*$/.test(tail[tail.length - 1])) {
      // A row still being typed: wait for its closing pipe.
      out = lines.slice(0, -1).join('\n')
    }
  }

  return out
}

// ── links and pictures ────────────────────────────────────────────────────
/** Only links the system browser should get. `javascript:`, `data:`, `file:` and relative links stay text. */
export function safeHref(href: string): null | string {
  const value = href.trim()

  if (/^mailto:[^\s]+@[^\s]+$/i.test(value)) {
    return value
  }

  try {
    const url = new URL(value)

    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

const open = (href: string) => (event: { preventDefault(): void }) => {
  event.preventDefault()
  void native.openExternal(href)
}

/** A path on the Hermes machine: `/…`, `~/…`, `C:\…` or a `file://` URL. */
function hermesPath(src: string): null | string {
  if (/^file:\/\//i.test(src)) {
    try {
      const path = decodeURIComponent(new URL(src).pathname)

      return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
    } catch {
      return null
    }
  }

  return /^(\/(?!\/)|~\/|[A-Za-z]:[\\/])/.test(src) ? src : null
}

function Picture({ src, alt, title }: { src: string; alt: string; title?: null | string }) {
  const path = hermesPath(src)
  const remote = !path && /^https?:\/\//i.test(src) ? src : null
  const inline = !path && /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml)[;,]/i.test(src) ? src : null
  const [loaded, setLoaded] = useState<null | { source: string; url: string }>(inline ? { source: src, url: inline } : null)
  const [failed, setFailed] = useState<null | string>(null)
  // Never reuse consent or a fetched URL if a streaming message changes src.
  const shown = loaded?.source === src ? loaded.url : inline

  useEffect(() => {
    setLoaded(inline ? { source: src, url: inline } : null)
    setFailed(null)
    if (!path) {
      return
    }

    let live = true
    readHermesImage(path)
      .then(url => live && setLoaded({ source: src, url }))
      .catch(() => live && setFailed(src))

    return () => {
      live = false
    }
  }, [inline, path, src])

  if (remote && !shown && failed !== src) {
    let host = 'external site'
    try { host = new URL(remote).host || host } catch {}
    return (
      <button className="md-img-missing md-img-load" onClick={() => setLoaded({ source: src, url: remote })} title={`Load an image from ${host}`} type="button">
        <Icon name="image" size={13} />
        Load image from {host}
      </button>
    )
  }

  if (failed === src || !shown) {
    return (
      <span className="md-img-missing" title={src}>
        <Icon name="image" size={13} />
        {alt || src.split(/[\\/]/).pop() || 'picture'}
        {path && failed !== src ? <span className="spinner xs" /> : null}
      </span>
    )
  }

  return (
    <img
      alt={alt}
      className="md-img"
      onClick={() => $lightbox.set({ name: alt || src.split(/[\\/?#]/).filter(Boolean).pop() || 'Picture', src: shown })}
      onError={() => setFailed(src)}
      referrerPolicy="no-referrer"
      src={shown}
      title={title || alt || undefined}
    />
  )
}

// ── code and math ─────────────────────────────────────────────────────────
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false)
  const html = useMemo(() => highlight(code, lang), [code, lang])

  const copy = async () => {
    if (await native.copyText(code)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }
  }

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang ? languageLabel(lang) : 'Code'}</span>
        <button aria-label="Copy code" className="md-code-copy" onClick={() => void copy()} type="button">
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{html !== null ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}</pre>
    </div>
  )
}

function MathView({ tex, display }: { tex: string; display: boolean }) {
  const state = useStore($katex)

  useEffect(loadKatex, [])

  const html = state === 'ready' ? renderMath(tex, display) : null
  const Tag = display ? 'div' : 'span'

  return html !== null ? (
    <Tag className={display ? 'md-math-block' : 'md-math'} dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <Tag className={display ? 'md-math-block md-math-src' : 'md-math md-math-src'}>{tex}</Tag>
  )
}

// ── tokens → elements ─────────────────────────────────────────────────────
/** `@handle` in plain text, highlighted (never inside code or links). */
function withMentions(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /(^|[^\w@.])(@[a-z0-9_-]+)/gi
  let last = 0
  let match: null | RegExpExecArray
  let n = 0

  while ((match = pattern.exec(text))) {
    const at = match.index + match[1].length

    if (at > last) {
      out.push(text.slice(last, at))
    }

    out.push(
      <span className="mention" key={`${key}m${n++}`}>
        {match[2]}
      </span>
    )
    last = at + match[2].length
  }

  if (last < text.length) {
    out.push(text.slice(last))
  }

  return out
}

/** Marked leaves character references in text as written (`&amp;`); show the character. */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" }
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, name: string) => ENTITIES[name])

function inline(tokens: Token[] | undefined, key: string): ReactNode[] {
  return (tokens || []).map((token, i) => inlineToken(token, `${key}.${i}`))
}

function inlineToken(token: Token, key: string): ReactNode {
  switch (token.type) {
    case 'text': {
      const text = token as Tokens.Text

      return text.tokens?.length ? <span key={key}>{inline(text.tokens, key)}</span> : <span key={key}>{withMentions(decode(text.text), key)}</span>
    }
    case 'escape':
      return token.text
    case 'strong':
      return <strong key={key}>{inline(token.tokens, key)}</strong>
    case 'em':
      return <em key={key}>{inline(token.tokens, key)}</em>
    case 'del':
      return <del key={key}>{inline(token.tokens, key)}</del>
    case 'codespan':
      return <code key={key}>{decode((token as Tokens.Codespan).text)}</code>
    case 'br':
      return <br key={key} />
    case 'link': {
      const link = token as Tokens.Link
      const href = safeHref(link.href)

      return href ? (
        <a href={href} key={key} onAuxClick={open(href)} onClick={open(href)} rel="noreferrer" title={link.title || href}>
          {inline(link.tokens, key)}
        </a>
      ) : (
        <span key={key}>{inline(link.tokens, key)}</span>
      )
    }
    case 'image': {
      const image = token as Tokens.Image

      return <Picture alt={image.text} key={key} src={image.href} title={image.title} />
    }
    case 'mathInline':
      return <MathView display={Boolean(token.display)} key={key} tex={String(token.text)} />
    case 'html':
      // Raw HTML is shown as written, never as markup.
      return token.raw
    case 'checkbox':
      return null
    default:
      return 'tokens' in token && token.tokens ? <span key={key}>{inline(token.tokens, key)}</span> : String(token.raw || '')
  }
}

function blocks(tokens: Token[], key: string): ReactNode[] {
  return tokens.map((token, i) => block(token, `${key}.${i}`)).filter(node => node !== null)
}

function block(token: Token, key: string): ReactNode {
  switch (token.type) {
    case 'space':
    case 'def':
      return null
    case 'paragraph':
      return <p key={key}>{inline(token.tokens, key)}</p>
    case 'text': {
      // Tight list items hold text, not paragraphs.
      const text = token as Tokens.Text

      return <span key={key}>{text.tokens ? inline(text.tokens, key) : withMentions(decode(text.text), key)}</span>
    }
    case 'heading': {
      const heading = token as Tokens.Heading
      const Tag = `h${Math.min(6, Math.max(1, heading.depth))}` as 'h1'

      return (
        <Tag className={`md-h md-h${heading.depth}`} key={key}>
          {inline(heading.tokens, key)}
        </Tag>
      )
    }
    case 'code': {
      const code = token as Tokens.Code
      const lang = (code.lang || '').trim().split(/\s+/)[0] || ''

      return /^(math|latex|tex|katex)$/i.test(lang) ? <MathView display key={key} tex={code.text} /> : <CodeBlock code={code.text} key={key} lang={lang} />
    }
    case 'mathBlock':
      return <MathView display key={key} tex={String(token.text)} />
    case 'blockquote':
      return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, key)}</blockquote>
    case 'hr':
      return <hr key={key} />
    case 'list': {
      const list = token as Tokens.List
      const Tag = list.ordered ? 'ol' : 'ul'
      const tasks = list.items.some(item => item.task)

      return (
        <Tag className={tasks ? 'md-tasks' : undefined} data-loose={list.loose || undefined} key={key} start={list.ordered && list.start !== '' && list.start !== 1 ? Number(list.start) : undefined}>
          {list.items.map((item, n) => (
            <li data-task={item.task || undefined} key={`${key}-${n}`}>
              {item.task ? <input checked={Boolean(item.checked)} disabled readOnly tabIndex={-1} type="checkbox" /> : null}
              {blocks(item.tokens.filter(child => child.type !== 'checkbox'), `${key}-${n}`)}
            </li>
          ))}
        </Tag>
      )
    }
    case 'table': {
      const table = token as Tokens.Table
      const align = (a: null | string) => (a ? { textAlign: a as 'left' | 'right' | 'center' } : undefined)

      return (
        <div className="md-table" key={key}>
          <table>
            <thead>
              <tr>
                {table.header.map((cell, n) => (
                  <th key={n} style={align(table.align[n])}>
                    {inline(cell.tokens, `${key}h${n}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, n) => (
                    <td key={n} style={align(table.align[n])}>
                      {inline(cell.tokens, `${key}r${r}c${n}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'html':
      // Raw HTML is shown as written, never as markup.
      return (
        <p className="md-raw" key={key}>
          {token.raw.trim()}
        </p>
      )
    default:
      return 'tokens' in token && token.tokens ? <div key={key}>{inline(token.tokens, key)}</div> : null
  }
}

// ── the component ─────────────────────────────────────────────────────────
/** Finished messages are drawn once and reused, so long threads stay quick when they re-render. */
const done = new Map<string, ReactNode>()
const MAX_CACHED = 400

function render(text: string): ReactNode {
  try {
    return blocks(parser.lexer(text.replace(/\r\n?/g, '\n')), 'b')
  } catch {
    return <p className="md-raw">{text}</p>
  }
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const body = useMemo(() => {
    if (streaming) {
      return render(steady(text))
    }

    const hit = done.get(text)

    if (hit !== undefined) {
      return hit
    }

    const node = render(text)

    if (done.size >= MAX_CACHED) {
      done.delete(done.keys().next().value as string)
    }

    done.set(text, node)

    return node
  }, [text, streaming])

  return <div className="md">{body}</div>
})
