/**
 * Installs the runner's localStorage before any app module loads. Several app modules read
 * localStorage while they load (the remembered machine view, the model picks), so the entry point
 * imports this file first. Import order is what makes it run first, in source and in the bundle.
 */
import { installLocalStorage } from './local-storage'

installLocalStorage(process.env.RUNNER_STATE_DIR || 'runner-state')
