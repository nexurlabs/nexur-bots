// Which of the app's tools run where once the VM runner answers group conversations.
//
// The runner (runner/) answers the four group-conversation tools. The app keeps the tools that need
// the user's screen or the app's own state (ask_user, send_file, ...). Each bot then has two MCP
// servers: `hermes-bots-groups` for the conversation tools and `hermes-bots-app` for the rest. With no
// runner configured, one server carries every tool, exactly as before.

const RUNNER_TOOL_NAMES = ['post_to_group', 'list_groups', 'rename_group', 'reply_in_thread']
const SERVER_GROUPS = 'hermes-bots-groups'
const SERVER_APP = 'hermes-bots-app'

const isRunnerTool = name => RUNNER_TOOL_NAMES.includes(name)

/**
 * The MCP registrations one bot needs, given where its group conversations run.
 *
 * `token` says which bearer the route expects: 'groups' for the group route, 'app' for the app's
 * tools route. `remove` lists server names to delete, so a switch back leaves no duplicate tools.
 */
function registrationsFor({ mcpUrl, runnerGroupsUrl, who }) {
  const pcBase = String(mcpUrl).replace(/\/mcp$/, '')
  const name = encodeURIComponent(who)

  if (!runnerGroupsUrl) {
    return {
      add: [{ name: SERVER_GROUPS, url: `${pcBase}/groups/${name}`, token: 'groups' }],
      remove: [SERVER_APP]
    }
  }

  return {
    add: [
      { name: SERVER_GROUPS, url: `${String(runnerGroupsUrl).replace(/\/+$/, '')}/groups/${name}`, token: 'groups' },
      { name: SERVER_APP, url: `${pcBase}/app/${name}`, token: 'app' }
    ],
    remove: []
  }
}

module.exports = { RUNNER_TOOL_NAMES, SERVER_GROUPS, SERVER_APP, isRunnerTool, registrationsFor }
