// The app's settings file: a read that fails must keep the last good copy, so the runner setting
// doesn't drop out for a moment (which would move the bots' group routes back to this PC).
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Runs the real readSettings / writeSettings from electron/main.cjs, against a fake file system.
function load(files) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf('let lastSettings = null')
  const writeAt = source.indexOf('function writeSettings', start)
  const end = source.indexOf('\n}\n', writeAt) + 3

  assert.ok(start > 0 && writeAt > start && end > writeAt, 'the settings helpers are in electron/main.cjs')

  const fake = {
    readFileSync: p => {
      if (!files.has(p)) throw new Error('ENOENT')
      return files.get(p)
    },
    existsSync: p => files.has(p),
    writeFileSync: (p, data) => files.set(p, data),
    renameSync: (from, to) => {
      files.set(to, files.get(from))
      files.delete(from)
    },
    mkdirSync: () => undefined
  }

  const sandbox = { fs: fake, path, settingsPath: () => '/app/settings.json' }
  const api = vm.runInNewContext(`${source.slice(start, end)}\n({ readSettings, writeSettings, last: () => lastSettings })`, sandbox)

  return { ...api, files }
}

test('a missing settings file reads as empty settings', () => {
  const { readSettings } = load(new Map())

  // The object comes from the sandbox's realm, so compare its keys rather than the object itself.
  assert.deepEqual(Object.keys(readSettings()), [])
})

test('a settings file that fails to parse keeps the last good copy', () => {
  const files = new Map([['/app/settings.json', JSON.stringify({ runnerGroupsUrl: 'http://127.0.0.1:40377', connections: [] })]])
  const { readSettings, files: store } = load(files)

  assert.equal(readSettings().runnerGroupsUrl, 'http://127.0.0.1:40377')

  // A write caught half way: the next read must not come back empty.
  store.set('/app/settings.json', '{"runnerGroupsUrl": "http://127.0.0.1:403')

  assert.equal(readSettings().runnerGroupsUrl, 'http://127.0.0.1:40377')
})

test('writing settings goes through a temporary file and keeps the new copy for the next read', () => {
  const files = new Map()
  const { writeSettings, readSettings, files: store } = load(files)

  writeSettings({ runnerGroupsUrl: 'http://127.0.0.1:40377' })

  assert.equal(store.has('/app/settings.json.tmp'), false)
  assert.equal(JSON.parse(store.get('/app/settings.json')).runnerGroupsUrl, 'http://127.0.0.1:40377')
  assert.equal(readSettings().runnerGroupsUrl, 'http://127.0.0.1:40377')
})
