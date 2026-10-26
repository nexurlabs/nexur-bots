/**
 * The group tools the VM runner serves to the bots, over the same HTTP shape the app's server uses.
 *
 * A bot calls /groups/<profile> with its own bearer token. A token only opens its own route, and a
 * post_to_group from a bot lands in the group as that bot and wakes its teammates in the runner.
 * Only the gateway transport is faked, as in the other runner tests.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { gateway } = await import('../src/lib/gateway')

interface Call {
  method: string
  params: Record<string, any>
}

const calls: Call[] = []
let epoch = 0

const PROFILE_ROWS = [
  { name: 'default', is_default: true, ui_meta: {} },
  { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha', lead: true } } },
  { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
]

gateway.connect = async () => {
  gateway.state.set('open')
}

gateway.request = (async (method: string, params: Record<string, any> = {}) => {
  calls.push({ method, params })

  if (method === 'profiles.list') return { profiles: PROFILE_ROWS }
  if (method === 'session.resume') {
    return { session_id: `rt${++epoch}:${params.profile}`, messages: [], running: false, inflight: null }
  }

  return {}
}) as typeof gateway.request

const submittedTo = (member: string) => calls.filter(call => call.method === 'prompt.submit' && call.params.profile === member)

const waitFor = async (predicate: () => boolean, what: string) => {
  const deadline = Date.now() + 2000

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const SECRET = 'a-test-secret-for-the-groups-server-0123456789'
let stateDir = ''

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'runner-groups-'))
  calls.length = 0
})

afterEach(async () => {
  const rooms = await import('../src/lib/rooms')
  const store = await import('../src/lib/store')

  for (const room of Object.values(rooms.$rooms.get())) {
    await rooms.stopRoom(room.key)
    rooms.deleteRoom(room.key)
  }

  rooms.$rooms.set({})
  rooms.setConductor('app')

  for (const name of Object.keys(store.$busy.get())) {
    for (const scope of ['dm', 'group', 'external'] as const) {
      store.releaseBusy(name, scope)
    }
  }

  rmSync(stateDir, { recursive: true, force: true })
})

async function rpc(port: number, profile: string, token: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}/groups/${profile}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null }
}

test('the bots reach their own group tools with their own token, and nothing else', async () => {
  const { startHost } = await import('../runner/host')
  const { startGroupsServer, groupToken, loadOrCreateSecret } = await import('../runner/groups-server')
  const host = await startHost({ hermesUrl: 'http://runner-test', stateDir, readToken: async () => 'test-token' })
  const server = await startGroupsServer({ secret: SECRET })

  try {
    const alphaToken = groupToken(SECRET, 'alpha')
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

    expect((await rpc(server.port, 'alpha', '', list)).status).toBe(401)
    expect((await rpc(server.port, 'alpha', 'not-a-token', list)).status).toBe(401)
    // Beta's token must not open alpha's route.
    expect((await rpc(server.port, 'alpha', groupToken(SECRET, 'beta'), list)).status).toBe(401)

    const ok = await rpc(server.port, 'alpha', alphaToken, list)
    expect(ok.status).toBe(200)
    expect(ok.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['post_to_group', 'list_groups', 'rename_group', 'reply_in_thread'])

    // The secret is kept across restarts, so the bots' registrations stay valid.
    expect(loadOrCreateSecret(stateDir)).toBe(loadOrCreateSecret(stateDir))
  } finally {
    server.close()
    host.close()
  }
})

test('a post_to_group from a bot lands in the group as that bot and wakes its teammates', async () => {
  const { startHost } = await import('../runner/host')
  const { startGroupsServer, groupToken } = await import('../runner/groups-server')
  const rooms = await import('../src/lib/rooms')
  const host = await startHost({ hermesUrl: 'http://runner-test', stateDir, readToken: async () => 'test-token' })
  const server = await startGroupsServer({ secret: SECRET })

  try {
    const room = rooms.createRoom('Team group', ['alpha', 'beta'], { reply: 'everyone', runner: true })
    const call = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'post_to_group', arguments: { group: 'Team group', text: '@beta please check the build' } }
    }

    const result = await rpc(server.port, 'alpha', groupToken(SECRET, 'alpha'), call)
    expect(result.json.result.isError).toBe(false)

    const posted = rooms.$rooms.get()[room.key]?.log.find(entry => entry.from.name === 'alpha' && entry.text.includes('please check the build'))
    expect(posted).toBeDefined()

    await waitFor(() => submittedTo('beta').length === 1, 'beta to be woken by alpha')
  } finally {
    server.close()
    host.close()
  }
})

test('list_groups answers with the groups the bot is in', async () => {
  const { startHost } = await import('../runner/host')
  const { startGroupsServer, groupToken } = await import('../runner/groups-server')
  const rooms = await import('../src/lib/rooms')
  const host = await startHost({ hermesUrl: 'http://runner-test', stateDir, readToken: async () => 'test-token' })
  const server = await startGroupsServer({ secret: SECRET })

  try {
    rooms.createRoom('Listed group', ['alpha'], { reply: 'everyone', runner: true })
    const result = await rpc(server.port, 'alpha', groupToken(SECRET, 'alpha'), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_groups', arguments: {} }
    })

    expect(result.json.result.isError).toBe(false)
    expect(result.json.result.content[0].text).toContain('Listed group')
  } finally {
    server.close()
    host.close()
  }
})
