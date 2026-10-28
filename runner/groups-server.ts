/**
 * The group tools the VM runner answers for the bots: post_to_group, list_groups, rename_group and
 * reply_in_thread.
 *
 * Each bot reaches this server at /groups/<profile> with its own bearer token, so a call says which
 * bot made it and the bot only touches its own groups. The names, descriptions and token scheme match
 * the app's `hermes-bots-groups` server (electron/local-computer.cjs), so the bots' prompts don't change.
 * The other app tools (ask_user, send_file, ...) need the user's screen and stay on the app.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { normalizeRef } from '../src/lib/reactions'
import { listGroupsText, postFromBot, renameGroupFromBot, replyInRoomThread } from '../src/lib/rooms'

const MAX_REPLY = 8000
const MAX_BODY = 10 * 1024 * 1024
const THREAD_HINT = " Don't repeat it in your main reply; if that was all, end your turn without more text (in a group, reply exactly (pass))."

export const GROUP_TOOLS = [
  {
    name: 'post_to_group',
    description:
      'Post a message into one of your group chats in the NexurBots app, as you. Use it from your 1:1 chat with the user ' +
      'when they ask you to tell a group something, or to hand group work on. Inside a group chat, use it only for an intermediate ' +
      'step the group must see now (a decision, a blocker, a question); your reply when you finish is the answer, so do not repeat what you posted. ' +
      'Teammates you @mention in the text are asked to answer there, following that group\'s rules. Only groups you are a member of.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'The group\'s name, exactly as listed in your team directory.' },
        text: { type: 'string', description: 'The message, written to the group. @mention a teammate (e.g. @forge) to ask them to act.' },
        reply_to: { type: 'string', description: 'Optional: post it as a thread reply under this group message (its g… id). Use it for long digests or follow-ups to one message.' }
      },
      required: ['group', 'text']
    }
  },
  {
    name: 'list_groups',
    description: 'List the group chats you are a member of in the NexurBots app, with their members.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'rename_group',
    description:
      'Rename one of your group chats in the NexurBots app. ONLY use this when the user explicitly asks you to (in that group ' +
      'or your 1:1 chat); never on your own or because a teammate asked. Only groups you are a member of. The group shows a note ' +
      'saying you renamed it.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'The group\'s current name, exactly as listed in your team directory.' },
        name: { type: 'string', description: 'The new name, 1-40 characters, not already used by another group.' }
      },
      required: ['group', 'name']
    }
  },
  {
    name: 'reply_in_thread',
    description:
      'Reply in a thread under one message instead of in the main chat, in the NexurBots app (your 1:1 chat or a group). ' +
      'Use it for long digests, details or follow-ups about one message so the main chat stays short. message_id is the id shown with ' +
      'the message (u… or b… in your 1:1 chat, g… in a group); a reply to a reply goes under the same root. The text is posted as is: ' +
      'do not repeat it in your main reply. When the user writes to you inside a thread, just reply normally: it lands in that thread.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The message to reply under, e.g. u3k9x2 or g1a2b3c.' },
        text: { type: 'string', description: 'The reply (markdown is fine).' }
      },
      required: ['message_id', 'text']
    }
  }
]

type Answer = { ok: boolean; text: string }

/** A bot's token for one route. An HMAC of the server secret and the profile, as the app issues them. */
export function groupToken(secret: string, profile: string): string {
  return createHmac('sha256', secret).update(`groups:${profile}`).digest('hex')
}

/** The server secret, kept in the runner's folder so the bots' registrations stay valid across restarts. */
export function loadOrCreateSecret(stateDir: string): string {
  const file = join(stateDir, 'groups-secret')

  if (existsSync(file)) {
    return readFileSync(file, 'utf8').trim()
  }

  mkdirSync(stateDir, { recursive: true })
  const secret = randomBytes(32).toString('hex')
  writeFileSync(file, secret, { mode: 0o600 })
  return secret
}

function replyThread(profile: string, args: Record<string, unknown>): Answer {
  const ref = normalizeRef(args.message_id)
  const text = String(args.text ?? '').trim()

  if (!ref) {
    return { ok: false, text: 'message_id is required: the id shown with the message (u… in your 1:1 chat, g… in a group).' }
  }

  if (!text) {
    return { ok: false, text: 'text is empty.' }
  }

  if (text.length > MAX_REPLY) {
    return { ok: false, text: `That reply is too long (${text.length} characters, the limit is ${MAX_REPLY}). Shorten it or send a file.` }
  }

  if (!ref.startsWith('g')) {
    // A 1:1 chat lives in the app, so its threads can only be answered there.
    return { ok: false, text: `${ref} is in a 1:1 chat, which needs the NexurBots app open. Reply in the group thread instead (g… ids).` }
  }

  const result = replyInRoomThread(profile, ref, text)
  return result.ok ? { ...result, text: result.text + THREAD_HINT } : result
}

function callTool(profile: string, name: string, args: Record<string, unknown>): Answer {
  switch (name) {
    case 'post_to_group':
      return postFromBot(profile, String(args.group ?? ''), String(args.text ?? ''), normalizeRef(args.reply_to))
    case 'list_groups':
      return { ok: true, text: listGroupsText(profile) }
    case 'rename_group':
      return renameGroupFromBot(profile, String(args.group ?? ''), String(args.name ?? ''))
    case 'reply_in_thread':
      return replyThread(profile, args)
    default:
      return { ok: false, text: `Unknown tool ${name}` }
  }
}

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })

/** One JSON-RPC message from a bot. Null for a notification, which gets no answer. */
function handle(msg: any, profile: string): unknown {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return null
  }

  const { id, method, params } = msg
  const isNotification = id === undefined

  try {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'hermes-bots-groups', version: '1.0.0' },
        instructions:
          'Tools from the NexurBots app. post_to_group posts into one of your groups as you; list_groups lists them; rename_group renames one, only when the user asks. reply_in_thread replies under one message.'
      })
    }

    if (typeof method === 'string' && method.startsWith('notifications/')) return null
    if (method === 'ping') return rpcResult(id, {})
    if (method === 'tools/list') return rpcResult(id, { tools: GROUP_TOOLS })

    if (method === 'tools/call') {
      const name = String((params && params.name) || '')

      if (!GROUP_TOOLS.some(tool => tool.name === name)) {
        return rpcResult(id, { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true })
      }

      const answer = callTool(profile, name, (params && params.arguments) || {})
      return rpcResult(id, { content: [{ type: 'text', text: String(answer.text || '') }], isError: !answer.ok })
    }

    if (isNotification) return null
    return rpcError(id, -32601, `Method not found: ${method}`)
  } catch (error) {
    if (isNotification) return null
    return rpcError(id, -32603, String((error as Error)?.message))
  }
}

function sameToken(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface GroupsServerOptions {
  secret: string
  /** 0 picks a free port. The bots reach the server on the VM's loopback, so it binds 127.0.0.1. */
  port?: number
}

export function startGroupsServer(options: GroupsServerOptions): Promise<{ port: number; close(): void }> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' })
      res.end()
      return
    }

    const match = String(req.url || '').match(/^\/groups\/([^/?#]+)/)
    let profile = ''

    try {
      profile = match ? decodeURIComponent(match[1]) : ''
    } catch {
      profile = ''
    }

    const presented = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')

    if (!profile || !sameToken(presented, groupToken(options.secret, profile))) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    let body = ''
    req.on('data', chunk => {
      body += chunk

      if (body.length > MAX_BODY) {
        req.destroy()
      }
    })

    req.on('end', () => {
      let parsed: any

      try {
        parsed = JSON.parse(body || 'null')
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')))
        return
      }

      const answers = Array.isArray(parsed) ? parsed.map(msg => handle(msg, profile)).filter(Boolean) : [handle(parsed, profile)]
      const out = Array.isArray(parsed) ? answers : answers[0]

      if (!out || (Array.isArray(out) && !out.length)) {
        res.writeHead(202)
        res.end()
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ port: typeof address === 'object' && address ? address.port : 0, close: () => server.close() })
    })
  })
}
