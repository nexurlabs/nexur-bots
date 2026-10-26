/**
 * A file-backed localStorage for the headless runner. The app's modules read and write
 * localStorage directly (room logs, read marks, bot picks), so the runner gives them the same
 * surface and keeps the values in one JSON file in the runner's state folder.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SAVE_DELAY_MS = 200

let active: { dispose(): void } | null = null

export function installLocalStorage(stateDir: string) {
  // A second install replaces the first. The old one's pending save must not write over the new state.
  active?.dispose()

  const file = join(stateDir, 'runner-state.json')
  const values = new Map<string, string>()
  let disposed = false

  try {
    for (const [key, value] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
      values.set(key, String(value))
    }
  } catch {
    // No state yet, or an unreadable file: start empty rather than refuse to run.
  }

  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = null
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(values)))
    renameSync(tmp, file)
  }

  const save = () => {
    if (timer || disposed) return
    timer = setTimeout(() => {
      timer = null
      try {
        flush()
      } catch (error) {
        console.error('runner: could not save state', error)
      }
    }, SAVE_DELAY_MS)
  }

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (values.has(key) ? values.get(key) : null),
      setItem: (key: string, value: string) => {
        values.set(key, String(value))
        save()
      },
      removeItem: (key: string) => {
        values.delete(key)
        save()
      },
      clear: () => {
        values.clear()
        save()
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size
      }
    }
  })

  const instance = {
    flush,
    dispose() {
      disposed = true

      if (timer) clearTimeout(timer)
      timer = null
    }
  }

  active = instance
  return instance
}
