/**
 * Picks up the messages the app posts into the groups this runner owns.
 *
 * The app writes its messages into the room log it syncs to Hermes. Each pass reloads that log and
 * starts a turn for every user message the runner hasn't seen in a group it owns. Every pass records
 * the user messages of every group, owned or not, so a group handed to the runner later starts from
 * where it is and does not replay what was said while the app owned it.
 */
import { refreshProfiles } from '../src/lib/store'
import { $rooms, loadRooms, ownsTurns, pickUpMessage } from '../src/lib/rooms'

const SEEN_KEY = 'runner-picked'
const SEEN_MAX = 2000

function readSeen(): Set<string> | null {
  const raw = localStorage.getItem(SEEN_KEY)

  if (!raw) {
    return null
  }

  try {
    return new Set<string>(JSON.parse(raw))
  } catch {
    return null
  }
}

function writeSeen(ids: Set<string>) {
  localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-SEEN_MAX)))
}

/** One pass: reload the synced rooms, then wake the owned groups for user messages not seen before. */
export async function pickUpNewMessages() {
  await refreshProfiles()
  loadRooms()

  const baseline = readSeen() === null
  const seen = readSeen() ?? new Set<string>()

  for (const room of Object.values($rooms.get())) {
    const owned = ownsTurns(room)

    for (const entry of room.log) {
      if (entry.from.kind !== 'user' || seen.has(entry.id)) {
        continue
      }

      seen.add(entry.id)

      if (owned && !baseline) {
        pickUpMessage(room.key, entry)
      }
    }
  }

  writeSeen(seen)
}

/** Runs a pass every few seconds until stopped. A failed pass is logged and the loop keeps going. */
export function startPickup(intervalMs = 3000) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const tick = async () => {
    try {
      await pickUpNewMessages()
    } catch (error) {
      console.warn('runner: pickup pass failed', error)
    }

    if (!stopped) {
      timer = setTimeout(tick, intervalMs)
    }
  }

  timer = setTimeout(tick, intervalMs)

  return {
    stop() {
      stopped = true

      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}
