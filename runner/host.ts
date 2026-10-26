/**
 * The headless room host: the app's own conductor (src/lib/rooms.ts) running without a window.
 *
 * It connects to Hermes the way the app does, loads the bots and rooms, and then the rooms run on
 * their own. Wakes, turns, replies and handoffs are the app's modules, not a copy of them, so a
 * fix in the app reaches the runner too.
 */
import { installLocalStorage } from './local-storage'

export interface HostOptions {
  /** The Hermes gateway websocket, the same URL the app connects to. */
  wsUrl: string
  /** Folder for the runner's state (rooms, read marks, notes). */
  stateDir: string
}

export async function startHost(options: HostOptions) {
  // The app's modules read localStorage when they load, so the shim goes in first. Every app module
  // is imported below, after it, rather than at the top of this file.
  const storage = installLocalStorage(options.stateDir)
  const { gateway } = await import('../src/lib/gateway')
  const { refreshProfiles } = await import('../src/lib/store')
  const { loadRooms } = await import('../src/lib/rooms')
  const { warmTeam } = await import('../src/lib/team')

  await gateway.connect(options.wsUrl)
  await refreshProfiles()
  loadRooms()
  warmTeam()

  return {
    gateway,
    close() {
      gateway.close()
      storage.flush()
    }
  }
}
