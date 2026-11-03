# Contributing to NexurBots

Thanks for helping. NexurBots is a desktop app that talks to [Hermes Agent](https://github.com/NousResearch/hermes-agent). Please start there if you're new to Hermes.

## Before you start

- Open an issue first for anything bigger than a small fix, so we can agree on the approach.
- Keep changes focused. One pull request should do one thing.
- Keep the app free of personal data: no real names, emails, IP addresses or account names in code, tests, demo data or screenshots.

## Setup

Install Node.js 22.12 or newer and Bun 1.4.2 or newer. The repository uses `bun.lock`; use the frozen install so dependencies match CI.

```sh
bun install --frozen-lockfile
npm run check   # syntax checks for the Electron files
npm test        # Node tests plus the selected Bun suites
bun test --isolate ./tests/*.test.ts   # all TypeScript tests, as in CI
bunx tsc --noEmit -p .
bun run build   # bundles the app into ./app
```

Run the app with `bun run start`. Preview the interface without Hermes by opening `app/renderer/index.html` with `#chat`, `#room` or `#connect` on the end of the address.

## Pull requests

- Add or update tests for behavior you change. CI runs the Node tests, the Bun tests and a TypeScript check, plus a smoke test of the built app.
- Describe what changed and how you tested it.
- Don't commit build output, `.env` files, keys or tokens.

## Security

Don't report security problems in a public issue. See [SECURITY.md](SECURITY.md).
