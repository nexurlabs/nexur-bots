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
  /** Mark every group as the runner's, so the app stops answering in them. Cutover only. */
  ownAllRooms?: boolean
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

  rooms.setConductor('runner')
  await gateway.connect(options.wsUrl)
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
