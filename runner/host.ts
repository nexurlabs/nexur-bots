/**
 * The headless room host: the app's own conductor (src/lib/rooms.ts) running without a window.
 *
 * It connects to Hermes the way the app does, loads the bots and rooms, and then the rooms run on
 * their own. Wakes, turns, replies and handoffs are the app's modules, not a copy of them, so a
 * fix in the app reaches the runner too.
 */
import { installLocalStorage } from './local-storage'

export interface HostOptions {
  /** The Hermes dashboard address, e.g. http://127.0.0.1:42687. Its websocket is at /api/ws. */
  hermesUrl: string
  /** Folder for the runner's state (rooms, read marks, notes). */
  stateDir: string
  /** Mark every group as the runner's, so the app stops answering in them. Cutover only. */
  ownAllRooms?: boolean
  /** Reads the session token. The default reads it from the page Hermes serves, as the app does. */
  readToken?: (hermesUrl: string) => Promise<string>
}

/** The session token Hermes serves in its page (`window.__HERMES_SESSION_TOKEN__`), read the way the app reads it. */
export async function readServedToken(hermesUrl: string): Promise<string> {
  const response = await fetch(hermesUrl.replace(/\/?$/, '/'), { signal: AbortSignal.timeout(4000) })
  const html = await response.text()
  const match = /window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:\\.|[^"\\])*")/.exec(html)

  if (!match) {
    throw new Error('Hermes did not serve a session token')
  }

  return JSON.parse(match[1])
}

/** The gateway websocket for an address and token, the same URL the app builds. */
export function wsUrlFor(hermesUrl: string, token: string): string {
  const url = new URL(hermesUrl.replace(/\/?$/, '/') + 'api/ws')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

  if (token) {
    url.searchParams.set('token', token)
  }

  return url.toString()
}

export async function startHost(options: HostOptions) {
  // The app's modules read localStorage when they load, so the shim goes in first. Every app module
  // is imported below, after it, rather than at the top of this file.
  const storage = installLocalStorage(options.stateDir)
  const { gateway } = await import('../src/lib/gateway')
  const { refreshProfiles } = await import('../src/lib/store')
  const rooms = await import('../src/lib/rooms')
  const { warmTeam } = await import('../src/lib/team')
  const { pickUpNewMessages, startPickup } = await import('./pickup')
  const readToken = options.readToken ?? readServedToken

  // Hermes restarts issue a new token, so every reconnect reads the page again, as the app does.
  gateway.setResolver(async () => wsUrlFor(options.hermesUrl, await readToken(options.hermesUrl)))
  rooms.setConductor('runner')
  await gateway.connect(wsUrlFor(options.hermesUrl, await readToken(options.hermesUrl)))
  await refreshProfiles()
  rooms.loadRooms()

  if (options.ownAllRooms) {
    for (const room of Object.values(rooms.$rooms.get())) {
      if (!room.settings?.runner) {
        rooms.setRoomSettings(room.key, { ...room.settings, runner: true })
      }
    }
  }

  warmTeam()
  // The baseline pass records what is already in the rooms before the timed loop starts.
  await pickUpNewMessages()
  const pickup = startPickup()

  return {
    gateway,
    close() {
      pickup.stop()
      gateway.close()
      storage.flush()
    }
  }
}
