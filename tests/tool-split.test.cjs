// The tool split: with a VM runner, a bot's group conversation tools come from the runner and the
// app's own tools stay on this PC under their own server name. Without a runner nothing changes.
const assert = require('node:assert/strict')
const { test } = require('node:test')

const { registrationsFor, RUNNER_TOOL_NAMES, SERVER_GROUPS, SERVER_APP } = require('../electron/tool-routes.cjs')
const bridge = require('../electron/local-computer.cjs')

const MCP = 'http://127.0.0.1:40366/mcp'
const RUNNER = 'http://127.0.0.1:40377'

const UI_TOOLS = ['send_file', 'send_voice_memo', 'request_user_help', 'request_secret', 'ask_user', 'react_to_message', 'get_profile', 'update_profile']

test('without a runner, one server carries every tool, as before', () => {
  const plan = registrationsFor({ mcpUrl: MCP, runnerGroupsUrl: '', who: 'default' })

  assert.deepEqual(plan.add, [{ name: SERVER_GROUPS, url: 'http://127.0.0.1:40366/groups/default', token: 'groups' }])
  assert.deepEqual(plan.remove, [SERVER_APP])
})

test('with a runner, conversations go to the runner and the app tools stay on this PC', () => {
  const plan = registrationsFor({ mcpUrl: MCP, runnerGroupsUrl: `${RUNNER}/`, who: 'x-manager' })

  assert.deepEqual(plan.add, [
    { name: SERVER_GROUPS, url: `${RUNNER}/groups/x-manager`, token: 'groups' },
    { name: SERVER_APP, url: 'http://127.0.0.1:40366/app/x-manager', token: 'app' }
  ])
  assert.deepEqual(plan.remove, [])
})

test('the runner keeps the four conversation tools and the app keeps the other eight', () => {
  const names = bridge.APP_TOOLS.map(tool => tool.name).sort()

  assert.deepEqual(names, [...UI_TOOLS].sort())
  for (const tool of RUNNER_TOOL_NAMES) {
    assert.ok(!names.includes(tool), `${tool} must not be on the app route`)
  }
})

test('the app route answers its own tools only, with its own bearer', async () => {
  const { port } = await bridge.startServer()

  try {
    const call = (route, bearer, body) =>
      fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body)
      })

    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

    // The app route takes its own bearer, and only that one.
    const appList = await call('/app/default', bridge.appToken('default'), list)
    assert.equal(appList.status, 200)
    const appBody = await appList.json()
    assert.deepEqual(appBody.result.tools.map(tool => tool.name).sort(), [...UI_TOOLS].sort())
    assert.equal((await call('/app/default', bridge.groupToken('default'), list)).status, 401)

    // The app route refuses a conversation tool even when the bearer is right.
    const post = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'post_to_group', arguments: { group: 'g', text: 't' } } }
    const refused = await (await call('/app/default', bridge.appToken('default'), post)).json()
    assert.equal(refused.result.isError, true)
    assert.match(refused.result.content[0].text, /Unknown tool post_to_group/)

    // The group route keeps answering every tool for a bot that is still registered there.
    const groupList = await call('/groups/default', bridge.groupToken('default'), list)
    assert.equal(groupList.status, 200)
    assert.equal((await groupList.json()).result.tools.length, 12)
    assert.equal((await call('/groups/default', bridge.appToken('default'), list)).status, 401)
  } finally {
    bridge.stopServer()
  }
})
