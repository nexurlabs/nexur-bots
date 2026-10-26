/**
 * The VM runner's entry point. It runs the headless room host and the group tools server until it is
 * stopped.
 *
 * Settings come from the environment:
 *   HERMES_WS_URL          the Hermes gateway websocket on this machine (required)
 *   RUNNER_STATE_DIR       where the runner keeps its state (default ./runner-state)
 *   RUNNER_GROUPS_PORT     the group tools port on 127.0.0.1 (default: a free port, printed at start)
 *   RUNNER_OWN_ALL_ROOMS   1 marks every group as the runner's, so the app stops answering in them
 */
import { startHost } from './host'
import { loadOrCreateSecret, startGroupsServer } from './groups-server'

const wsUrl = process.env.HERMES_WS_URL

if (!wsUrl) {
  console.error('runner: HERMES_WS_URL is required (the Hermes gateway websocket on this machine)')
  process.exit(1)
}

const stateDir = process.env.RUNNER_STATE_DIR || 'runner-state'
const host = await startHost({ wsUrl, stateDir, ownAllRooms: process.env.RUNNER_OWN_ALL_ROOMS === '1' })
const server = await startGroupsServer({ secret: loadOrCreateSecret(stateDir), port: Number(process.env.RUNNER_GROUPS_PORT || 0) })

console.log(`runner: group tools on 127.0.0.1:${server.port}`)

const stop = () => {
  server.close()
  host.close()
  process.exit(0)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
