'use strict'
/**
 * A bot's first turn is gated on that bot being registered as ITS OWN groups route.
 *
 * `hermes-bots-groups` is registered once per Hermes profile at `/groups/<profile>` with a bearer
 * derived from the profile, so every tool call says who made it. A profile cloned from default
 * arrives carrying default's URL *and* default's valid bearer, and that inherited pair connects
 * perfectly well — as default. So a working MCP connection is not identity, and the app has to
 * confirm the profile's own entry before the bot's first turn.
 *
 * These tests drive the real functions extracted from electron/main.cjs against a fake Hermes. The
 * only fixture is the HTTP boundary; nothing else is stubbed. Controls come first in every case: a
 * test that fails because the harness is broken proves nothing.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')

const MAIN = require('node:fs').readFileSync(require.resolve('../electron/main.cjs'), 'utf8')
const TOOL_ROUTES = require('../electron/tool-routes.cjs')

/** A whole top-level function from the real source, brace-matched so the slice is always complete. */
const sliceFunction = (source, name, fallback = '') => {
  const at = source.indexOf(`function ${name}(`)

  if (at === -1) {
    // A source without this function is missing the fix, not broken. Emitting a stand-in lets each
    // test fail on its own assertion — which is the evidence — instead of every test dying on a
    // loader error that proves nothing about behaviour.
    return fallback
  }

  const start = source.slice(Math.max(0, at - 6), at) === 'async ' ? at - 6 : at
  const open = source.indexOf('{', at)
  let depth = 0
  let end = -1

  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--

      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }

  assert.notEqual(end, -1, `${name} must close`)

  return source.slice(start, end)
}

/**
 * Loads the identity gate exactly as main.cjs wires it: `registerThisPc` calls `registerMcp`, which
 * calls `confirmMcpEntry`, and it stores its verdict in `groupsReadyBy`. All four are extracted
 * together because that call chain IS the behaviour under test.
 */
const loadGate = (settings = {}) => {
  const body = [
    'const groupsReadyBy = new Map()',
    'const thisPcAsks = new Map()',
    'const localComputer = { SERVER_NAME: PC_SERVER, groupToken: name => groupTokens[name] || "", appToken: name => `app:${name}` }',
    'const { registrationsFor } = TOOL_ROUTES',
    // The app's settings file is not part of this test; no runner is configured, as on a fresh install.
    `const readSettings = () => (${JSON.stringify(settings)})`,
    // A source predating this fix has no `confirmMcpEntry` and no `groupsReady`; the stand-ins below
    // reproduce the old behaviour so the tests fail on their assertions rather than on a loader error.
    sliceFunction(MAIN, 'confirmMcpEntry', 'async function confirmMcpEntry() { return { ok: true } }'),
    sliceFunction(MAIN, 'markThisPcUntrusted', 'async function markThisPcUntrusted() { return true }'),
    sliceFunction(MAIN, 'registerMcp'),
    sliceFunction(MAIN, 'unregisterMcp', 'async function unregisterMcp() {}'),
    sliceFunction(MAIN, 'runnerGroupsUrl', 'function runnerGroupsUrl() { return "" }'),
    sliceFunction(MAIN, 'registerGroupTools'),
    sliceFunction(MAIN, 'registerThisPc'),
    sliceFunction(MAIN, 'groupsReady', 'function groupsReady() { return true }'),
    'return { registerThisPc, groupsReady, groupsReadyBy }'
  ].join('\n\n')

  // eslint-disable-next-line no-new-func
  return new Function(
    'fetch',
    'dbg',
    'PC_SERVER',
    'groupTokens',
    'TOOL_ROUTES',
    `${body}`
  )
}

const GROUP_SERVER = 'hermes-bots-groups'
const PC_SERVER = 'hermes-bots-this-pc'
const link = { baseUrl: 'http://127.0.0.1:9999/', hermesToken: 'root', mcpUrl: 'http://127.0.0.1:9999/mcp', mcpToken: 'pc' }

/**
 * A fake Hermes holding a config per profile, exactly like the real one: `stored` is the URL each
 * profile's entry actually points at. `register` decides what a POST does, which is how a clone
 * that keeps the inherited pair is modelled — the POST is accepted but nothing changes.
 */
function hermesFixture(behaviour = {}, settings = {}) {
  const seen = { listed: [], posted: [], tested: [] }
  // Per-profile config. `default` starts correct; x-manager starts holding default's pair, which is
  // the shape `profile_cmd --clone` produces.
  const config = {
    default: { [GROUP_SERVER]: { url: 'http://127.0.0.1:9999/groups/default', auth: 'header', enabled: true } },
    'x-manager': { [GROUP_SERVER]: { url: 'http://127.0.0.1:9999/groups/default', auth: 'header', enabled: true } }
  }
  // A register that silently does nothing is the clone case: the write is accepted, the entry stays.
  const lands = behaviour.lands === undefined ? true : behaviour.lands
  const reach = behaviour.reachable === undefined ? true : behaviour.reachable

  const fetchImpl = async (input, init = {}) => {
    const u = String(input)
    const method = init.method || 'GET'
    const profile = decodeURIComponent((u.match(/[?&]profile=([^&]+)/) || [])[1] || '') || 'default'
    const named = decodeURIComponent((u.match(/api\/mcp\/servers\/([^/?]+)/) || [])[1] || '')

    if (method === 'DELETE') {
      if (lands && config[profile]) delete config[profile][named]

      return new Response('', { status: 204 })
    }

    if (method === 'GET' && /api\/mcp\/servers/.test(u)) {
      seen.listed.push({ profile, url: u })

      if (behaviour.listStatus && behaviour.listStatus !== 200) {
        return new Response('{}', { status: behaviour.listStatus })
      }

      const servers = Object.entries(config[profile] || {}).map(([name, entry]) => ({ name, ...entry }))

      return new Response(JSON.stringify({ servers }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    if (method === 'POST' && /api\/mcp\/servers\/[^/?]+\/test/.test(u)) {
      seen.tested.push({ profile, name: named })

      if (behaviour.testStatus && behaviour.testStatus !== 200) {
        return new Response('{}', { status: behaviour.testStatus })
      }

      if (behaviour.testBody !== undefined) {
        return new Response(behaviour.testBody, { status: 200 })
      }

      // The route answers as whoever presents its bearer, so an inherited pair probes fine.
      return new Response(
        JSON.stringify(reach ? { ok: true, tools: [{ name: 'ask_user' }, { name: 'post_to_group' }] } : { ok: false, error: 'refused' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    if (method === 'POST' && /api\/mcp\/servers/.test(u)) {
      const body = JSON.parse(String(init.body || '{}'))
      seen.posted.push({ profile, name: body.name, url: body.url })

      if (behaviour.postStatus && behaviour.postStatus !== 200) {
        return new Response('{}', { status: behaviour.postStatus })
      }

      // `lands: false` accepts the write without applying it — a silent no-op that leaves the
      // inherited default pair in place, which is the whole defect.
      if (lands) config[profile] = { ...config[profile], [body.name]: { url: body.url, auth: 'header', enabled: true } }

      return new Response('{"ok":true}', { status: 200 })
    }

    return new Response('{}', { status: 404 })
  }

  const gate = loadGate(settings)(fetchImpl, () => undefined, PC_SERVER, { default: 'bearer-default', 'x-manager': 'bearer-x' }, TOOL_ROUTES)

  return { ...gate, seen, config, link }
}

// ── Controls: the known-good path must actually work ────────────────────────

test('control: a profile whose own route is written and confirmed is ready', async () => {
  const f = hermesFixture()

  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.equal(f.groupsReady('x-manager'), true, 'a correctly registered profile must be ready')
})

test('control: two profiles registering in turn each end up ready', async () => {
  const f = hermesFixture()

  await f.registerThisPc(f.link, 'default', 'default')
  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.equal(f.groupsReady('default'), true)
  assert.equal(f.groupsReady('x-manager'), true)
})

test('with a runner configured, conversations go to the runner and the app tools stay on this PC', async () => {
  const f = hermesFixture({}, { runnerGroupsUrl: 'http://127.0.0.1:40377' })

  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.equal(f.groupsReady('x-manager'), true, 'the runner entry must be confirmed before the first turn')
  assert.equal(f.config['x-manager'][GROUP_SERVER].url, 'http://127.0.0.1:40377/groups/x-manager')
  assert.equal(f.config['x-manager']['hermes-bots-app'].url, 'http://127.0.0.1:9999/app/x-manager')
})

// ── A -> B -> A, each profile confirmed against its own entry ───────────────

test('A -> B -> A: each bot gets its own route, and neither inherits the other', async () => {
  const f = hermesFixture()

  await f.registerThisPc(f.link, 'default', 'default')
  await f.registerThisPc(f.link, 'x-manager', 'x-manager')
  await f.registerThisPc(f.link, 'default', 'default')

  assert.equal(f.config.default[GROUP_SERVER].url, 'http://127.0.0.1:9999/groups/default')
  assert.equal(f.config['x-manager'][GROUP_SERVER].url, 'http://127.0.0.1:9999/groups/x-manager')
  assert.equal(f.groupsReady('default'), true)
  assert.equal(f.groupsReady('x-manager'), true)
})

test("A -> B -> A: a bot's turn stays blocked until its own route is written", async () => {
  const f = hermesFixture({ lands: false })

  await f.registerThisPc(f.link, 'default', 'default')
  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  // default's own write landed, so default is fine. x-manager's POST was accepted and applied to
  // nothing, so it is still holding default's route and must not be ready.
  assert.equal(f.groupsReady('default'), true)
  assert.equal(f.groupsReady('x-manager'), false, 'a profile still on another route is not ready')
})

// ── The inherited-pair clone: the case that produced the bug ────────────────

test('a clone carrying default\'s route and default\'s valid bearer is refused', async () => {
  // The write is accepted but does not land, so the clone keeps default's URL. That inherited pair
  // is genuinely valid — it would connect as default — which is exactly why a connectivity test
  // cannot stand in for identity.
  const f = hermesFixture({ lands: false })

  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.equal(f.config['x-manager'][GROUP_SERVER].url, 'http://127.0.0.1:9999/groups/default', 'still default\'s route')
  assert.equal(f.groupsReady('x-manager'), false, 'a route that is not this profile\'s is not ready')
  // Stronger than the old gate: the entry is refused before a probe is even spent, because a probe
  // would succeed against the inherited pair and prove nothing about this profile.
  assert.equal(f.seen.tested.filter(c => c.profile === 'x-manager').length, 0, 'no probe is spent on an entry that is not this profile\'s')
})

test('the probe runs only once the entry is this profile\'s own', async () => {
  // The ordering is the protection: confirm identity first, then spend the probe. A clone never
  // reaches the groups probe, so it can never be cleared by a connection that succeeds as somebody
  // else. This PC's own entry is unrelated and still probes normally.
  const clone = hermesFixture({ lands: false })
  const good = hermesFixture()

  await clone.registerThisPc(clone.link, 'x-manager', 'x-manager')
  await good.registerThisPc(good.link, 'x-manager', 'x-manager')

  const groupsProbes = f => f.seen.tested.filter(c => c.profile === 'x-manager' && c.name === GROUP_SERVER)

  assert.equal(groupsProbes(clone).length, 0, 'the clone never reaches the groups probe')
  assert.equal(groupsProbes(good).length, 1, 'a profile that owns its route is probed')
  assert.equal(clone.groupsReady('x-manager'), false)
  assert.equal(good.groupsReady('x-manager'), true)
})

// ── Unproven is not ready: every shape of it ────────────────────────────────

test('an unreadable config is not ready', async () => {
  const f = hermesFixture({ listStatus: 500 })

  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.equal(f.groupsReady('x-manager'), false)
})

test('a probe that answers HTTP 500 is not ready', async () => {
  const f = hermesFixture({ testStatus: 500 })

  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.equal(f.groupsReady('x-manager'), false)
})

test('a probe whose body is not JSON is not ready', async () => {
  const f = hermesFixture({ testBody: 'not-json' })

  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.equal(f.groupsReady('x-manager'), false)
})

test('a probe with no affirmative ok is not ready', async () => {
  const f = hermesFixture({ testBody: '{"tools":[]}' })

  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.equal(f.groupsReady('x-manager'), false)
})

test('an unreachable route is not ready', async () => {
  const f = hermesFixture({ reachable: false })

  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.equal(f.groupsReady('x-manager'), false)
})

test('a write Hermes refuses is not ready', async () => {
  const f = hermesFixture({ postStatus: 500 })

  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.equal(f.groupsReady('x-manager'), false)
})

test('a profile nobody registered is not ready', () => {
  const f = hermesFixture()

  // Fail-closed by construction: an absent proof is not a passing proof.
  assert.equal(f.groupsReady('never-registered'), false)
  assert.equal(f.groupsReady(), false, "absent means default, and absent default is not ready")
})

// ── This PC stays independent ───────────────────────────────────────────────

test('a working This PC registration is preserved when groups is refused', async () => {
  // `lands: false` makes every write a silent no-op, which is the clone case for groups. This PC's
  // entry is written under its own name on its own URL regardless, and the function's return value
  // tracks the PC entry alone — a refused groups write can never turn a working PC into a failure.
  const f = hermesFixture({ lands: false })

  const pcOk = await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.equal(typeof pcOk, 'boolean', 'the PC result is its own boolean')
  const pcWrites = f.seen.posted.filter(p => p.name === PC_SERVER)

  assert.equal(pcWrites.length, 1, 'the PC server is written under its own name')
  assert.equal(pcWrites[0].profile, 'x-manager')
  assert.equal(pcWrites[0].url, link.mcpUrl, 'the PC entry points at the PC MCP url')
  // And the groups refusal is still recorded separately, which is the whole point of splitting them.
  assert.equal(f.groupsReady('x-manager'), false, 'groups being refused does not follow the PC result')
})

test('the PC registration is written under its own name, not the groups name', async () => {
  const f = hermesFixture()

  await f.registerThisPc(f.link, 'x-manager', 'x-manager')

  assert.ok(f.seen.posted.some(p => p.profile === 'x-manager' && p.name === PC_SERVER && p.url === link.mcpUrl))
  assert.ok(f.seen.posted.some(p => p.profile === 'x-manager' && p.name === GROUP_SERVER && p.url.endsWith('/groups/x-manager')))
})

test('PC registration for one profile does not establish another profile\'s identity', async () => {
  const f = hermesFixture()

  await f.registerThisPc(f.link, 'default', 'default')

  // default's PC entry is fine; x-manager has proven nothing.
  assert.equal(f.groupsReady('default'), true)
  assert.equal(f.groupsReady('x-manager'), false)
})

// ── The identity the gate must never leak ───────────────────────────────────

test('nothing logged or returned carries a bearer', async () => {
  const lines = []

  // Run the real gate with logging captured, the way the app runs it, and give it a Hermes that
  // will reject it so every refusal path is taken.
  const gate = loadGate()(
    async () => new Response('{"servers":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    (...parts) => lines.push(parts.map(String).join(' ')),
    PC_SERVER,
    { default: 'bearer-default', 'x-manager': 'bearer-x' },
    TOOL_ROUTES
  )

  await gate.registerThisPc(link, 'x-manager', 'x-manager')

  assert.equal(gate.groupsReady('x-manager'), false, 'the refusal happened')
  const logged = lines.join('\n')
  assert.equal(logged.includes('bearer-x'), false, 'no bearer in the log')
  assert.equal(logged.includes('bearer-default'), false, 'no inherited bearer in the log')
})