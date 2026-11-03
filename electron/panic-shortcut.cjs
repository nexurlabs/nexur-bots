'use strict'

const ACCELERATOR = 'Control+Alt+Escape'

// Electron returns false (without throwing) if the shortcut is unavailable.
function setPanicShortcut(shortcuts, active, onPanic, log = () => {}) {
  try { shortcuts.unregister(ACCELERATOR) } catch {}
  if (!active) return true
  try {
    const registered = shortcuts.register(ACCELERATOR, onPanic)
    if (!registered) log('could not register panic hotkey: shortcut unavailable')
    return registered === true
  } catch (error) {
    log('could not register panic hotkey:', String(error && error.message))
    return false
  }
}

module.exports = { setPanicShortcut }
