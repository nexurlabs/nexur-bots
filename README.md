# NexurBots

A desktop app for talking to a team of bots. Each bot is a [Hermes Agent](https://github.com/NousResearch/hermes-agent) **profile**, so it keeps its own model, tools, skills, memory and history. Chat with one bot, or put several in a group and let them work together.

Hermes does the thinking. This app is the front end: roster, chats, groups, per-bot settings, attachments and an optional "control this PC" mode.

NexurBots is made by NexurLabs. Up to version 1.8.5 it was called Hermes Bots.

![A 1:1 chat with Nova, the team's Lead bot, next to its settings: model, approvals, routines and secrets](docs/screenshots/chat.png)

![A group chat where four bots split up a product launch, with the members list on the right](docs/screenshots/group.png)

![A bot asking before it right-clicks on your PC, with Deny, Allow for this chat and Allow once](docs/screenshots/approvals.png)

*Screenshots use the app's built-in preview data (see [Preview without Hermes](#preview-without-hermes)).*

## What you get

- **A roster of bots.** Every Hermes profile shows up as a bot. Give each a name, a face and a role. One bot can be the **Lead**; it answers first in groups and hands work to teammates.
- **1:1 chats** with live streaming, tool activity, approvals, copy and reply on any message, and share/export of a conversation.
- **Group chats.** Everyone in the group reads each message and decides whether to answer (a bot can reply `(pass)`), and `@mention` asks one bot directly. Bots can hand off to each other up to a turn limit. Per group you can choose who answers by default (everyone, the Lead, or only @mentioned bots), how `@bot stop` behaves, the turn limit, and shared instructions. Individual members can be set to **Quiet** so they only speak when mentioned.
- **Per-bot settings**, saved straight into that bot's own Hermes profile:
  - **Model** and provider, and how hard it thinks (reasoning effort, from Off up to Max; Hermes clamps Max to the strongest level the model supports)
  - **Tools** (toolsets) on or off
  - **Skills** on or off
  - **Connected apps** (MCP servers) on or off
  - **Approvals** (ask me / smart / never ask) and the **working folder**
  - **Memory**: what the bot has saved, to read, add to, edit or delete
- **Shared memory**: facts about you (name, time zone, preferences) that every bot knows. See [Memory](#memory).
- **Group posts from a 1:1 chat**: ask a bot to tell one of its groups something and it posts there as itself; teammates it @mentions answer in the group. See [Group posts](#group-posts).
- **Bots can rename themselves**: ask a bot to change its name, label or description and it does, with a note in your chat. See [Bots editing their own profile](#bots-editing-their-own-profile).
- **Shared folder**: one folder on the Hermes machine every bot can read and write, for handing work over as files. See [Shared folder](#shared-folder).
- **Attachments.** Send pictures, PDFs and any other file with the + button, by pasting, or by dragging into the chat. Pictures go to the model as images, PDFs are rendered to pages, and other files are staged in the bot's workspace for its tools to read.
- **Library tab** for each bot or group: the pictures and files you sent (with previews and save-a-copy), plus the links and images from replies.
- **Routines** per bot: tasks it runs on a schedule or once, on Hermes's own scheduler, with results in your chat with that bot. See [Routines](#routines).
- **This PC control** (off by default, per session): lets a bot see your screen and use the mouse and keyboard on Windows, with a panic key. See [Computer control](#computer-control).
- New bots can start as a **copy of your main Hermes setup**, so they already have your keys, tools and skills.

## Requirements

- **[Hermes Agent](https://github.com/NousResearch/hermes-agent) v0.22.3 or newer, installed first** (the oldest version this app is tested with). NexurBots is a front end for it: each bot is a Hermes profile, and the app connects to a Hermes you run on this computer, on a server, or over SSH. See [Step 0](#step-0-install-hermes-agent). NexurBots isn't affiliated with or endorsed by Nous Research.
- An AI provider set up in Hermes (with Hermes's own onboarding: `/login` in chat, or `hermes model` / `hermes setup`).
- To build and run from source: [Bun](https://bun.sh) 1.4 or newer (the scripts run on Bun) and Node.js; Electron is installed by `bun install`.
- Computer control uses PowerShell and `user32.dll`, so it is Windows only. Everything else is cross-platform.

## Quick install on Windows

One command in PowerShell installs everything:

```powershell
irm https://raw.githubusercontent.com/nexurlabs/nexur-bots/main/install.ps1 | iex
```

It asks whether to set up on **this PC** or a **VPS**. On this PC it installs Hermes Agent first if it's missing (the official installer from Step 0 below), then installs the latest NexurBots release and opens it. For a VPS it installs only the app: install Hermes on the VPS with Step 0, then add it in **Settings → Machines**. The download is checked against the release's `SHA256SUMS.txt`, and nothing is installed if it doesn't match.

To read the script before running it, download [`install.ps1`](install.ps1) and run `powershell -ExecutionPolicy Bypass -File .\install.ps1`. To do it all by hand instead, follow Step 0, then [Install on Windows](#install-on-windows).

## Step 0: Install Hermes Agent

NexurBots is the front end; [Hermes Agent](https://github.com/NousResearch/hermes-agent) does the work and must be installed first (skip this if you connect to a Hermes server or VM that already has it). These are the official one-liners from the Hermes Agent README:

**Linux, macOS, WSL2:**

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

To install without Hermes's interactive setup wizard (you can add a provider later with `hermes model`), pass `--skip-setup`:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup
```

**Windows (PowerShell):**

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

Then open a new terminal and check `hermes --version` (v0.22.3 or newer). More options: [installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation). If you pick **This computer** and Hermes isn't installed, the app shows the right command for your system with a copy button and a **Retry** button.

**Add an AI provider.** Hermes needs at least one AI provider before your bots can answer. The app doesn't ask for API keys; use Hermes's own onboarding: type `/login` in a chat, or run `hermes model` (or `hermes setup`) on the Hermes machine. If Hermes has no provider, the app shows a small notice saying so.

## Install on Windows

1. Open the [latest release](https://github.com/nexurlabs/nexur-bots/releases/latest) and download `NexurBots-Setup-<version>.exe`.
2. Run it. The installer isn't code-signed, so Windows SmartScreen says "Windows protected your PC". Click **More info → Run anyway**.
3. Choose to install for just you (no admin needed, installs to `%LOCALAPPDATA%\Programs\NexurBots`) or for all users, and pick a folder if you want a different one. It adds Start menu and Desktop shortcuts.

**Updating:** download the newer `NexurBots-Setup-<version>.exe` and run it. It installs over the old version in place; you don't need to uninstall first. There's no auto-update, so check Releases for new versions.

**Your settings** (connection, group chat history, window size and other app-side data) are in `%APPDATA%\NexurBots`, the same place as when running from source. (Versions called Hermes Bots kept them in `%APPDATA%\Hermes Bots`; the first time 1.8.6 or newer starts, it moves that folder to the new name.) Installing, updating and uninstalling leave them alone. The key your bots use to reach the app's This PC and group tools is also kept, encrypted for your Windows account, in `%LOCALAPPDATA%\NexurBots`, so clearing the settings folder doesn't cut off bots that are already running. Delete both folders after uninstalling to remove everything. Deleting both gives the app a new key for its This PC and group tools, so bots already running on a Hermes server keep the old key and their tool calls are refused until those bots restart. Clearing only the settings folder keeps the key and causes no such problem. Bots' own settings, memory and history are stored by Hermes, not here.

**Uninstall:** Settings → Apps → Installed apps → NexurBots → Uninstall.

## Linux and macOS

There's no packaged Linux or macOS build yet (releases are Windows installers only). Build and run from source instead:

1. Install Hermes Agent (Step 0 above) and check `hermes --version`.
2. Install [Bun](https://bun.sh) and Node.js 20+ (plus `git`).
3. Clone and start:

   ```sh
   git clone https://github.com/nexurlabs/nexur-bots.git
   cd nexur-bots
   bun install --frozen-lockfile
   bun run start
   ```

4. Pick **This computer** on the connect screen.

Settings live in `~/.config/NexurBots` on Linux and `~/Library/Application Support/NexurBots` on macOS. On Linux the window keeps its own minimize/maximize/close buttons in the top-right corner. The encrypted backup copy of the This PC key is Windows-only (it uses Windows DPAPI), so on Linux and macOS it lives only in the settings folder.

## Run it

Needs [Bun](https://bun.sh) (the build and test scripts run on Bun):

```sh
bun install --frozen-lockfile
bun run start    # builds into ./app and launches Electron
```

To build the Windows installer yourself (on Windows): `bun run dist:win`. It writes `dist/NexurBots-Setup-<version>.exe`. Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed; bump `version` in `package.json` to match the tag first. Before publishing, the workflow installs the installer silently and launches the installed app as a smoke test, and it attaches `SHA256SUMS.txt`.

`bun run build` only builds. The output in `./app` is a complete Electron app folder (`main.cjs`, `preload.cjs`, `renderer/`), so you can also package it with electron-builder, Electron Forge or your own packager, or drop it into an existing Electron runtime.

### Preview without Hermes

The UI can be opened with sample data and no server. Build, then open `app/renderer/index.html` in a browser with `#chat`, `#room` or `#connect` on the end of the address (for example `…/index.html#chat`). `#chat-approval` and `#room-approval` show approval cards; `#chat-memory` and `#chat-shared` show a bot's memory and the shared memory; `#chat-routines`, `#chat-newroutine` and `#chat-brief` show routines, the new-routine form and a routine's result in the chat; `#chat-editroutine` and `#chat-editonce` show the edit form for a repeating and a one-time routine; `#chat-post` and `#room-post` show a bot posting into a group from its 1:1 chat; `#chat-folder` and `#chat-file` show the shared folder and a file preview; `#chat-rename` and `#team-rename` show a bot renaming itself when asked, and the Team view after. `#chat-markdown` and `#chat-mdstream` show every Markdown element and a reply still arriving. `#chat-pcask` shows This PC approvals. `#connect-missing` shows the "Hermes Agent isn't installed" screen and `#chat-provider` the "no AI provider" notice. That mode is for design work: nothing is sent anywhere, and settings you change are not saved.

## Connecting to Hermes

On first launch pick one:

| Option | Use it when |
| --- | --- |
| **This computer** | Hermes runs on the same machine. The app finds it, or starts it for you. |
| **Remote server** | You have a Hermes server address and its session token. |
| **Over SSH** | Hermes runs on a VM. Give the host, user and (optionally) a key file; the app starts Hermes there and tunnels to it with your system `ssh`. |

Connections are remembered in the app's `settings.json` (Electron's user-data folder). Session tokens are encrypted with your operating system's secure storage when it's available; key file paths are stored as plain text. Nothing is sent anywhere except the Hermes you chose.

## How it maps onto Hermes

| In the app | In Hermes |
| --- | --- |
| A bot | A profile (`profiles.*`). Display name, face, role and Lead are stored in the profile's `ui_meta`. |
| A 1:1 chat | A session on that profile (`prompt.submit`, `session.*`). History is the profile's own session history. |
| A group | The group list and its settings are saved in Hermes (`ui_meta`), so they follow you between computers. The message log stays on the device you chat from. Each member runs in its own session on its own profile. |
| Model, tools, skills, apps | `profiles.describe` / `profiles.configure`, `model.options` |
| Approvals, working folder, reasoning | `config.get` / `config.set` |
| One message's thinking level (composer ✦ button) | `config.set` `reasoning` scoped to the chat session, restored on the next normal message |
| Attachments | `image.attach_bytes`, `pdf.attach`, `file.attach` |
| Routines | The bot's own cron jobs: `cron.manage` (`list`, `add` with `deliver: "bot-chat"`, `pause`, `resume`, `remove`), `POST /api/cron/jobs/{id}/trigger` for Run now, and `GET` / `PUT /api/cron/jobs/{id}?profile=` for Edit (`cron.manage` has no update action) |
| Approval cards | The `approval` server request, answered with `approval.respond`; `approval.received`, `request.cancel` and `approval.cancelled` for the card's lifecycle |
| A bot's memory | The profile's `memories/MEMORY.md` and `memories/USER.md` (Hermes's built-in memory, written by the bot's `memory` tool), read and written through `/api/fs/read-text` and `/api/fs/write-text`; size limits from `config.get` |
| Shared memory | The default profile's `ui_meta`, sent to every bot in the team directory |
| Group posts, renaming a group, a bot editing its own profile | An MCP server the app runs (`hermes-bots-groups`, tools `post_to_group`, `list_groups`, `rename_group`, `get_profile` and `update_profile`), registered on each bot's profile with `POST /api/mcp/servers` next to This PC |
| A bot's name, label, description | `ui_meta['hermes-bots']` (`title`, `label`, `description`) through `profiles.configure`, plus the profile's own `description`. The Hermes profile id never changes. |
| Shared folder | `<Hermes home>/team-shared`, through Hermes's managed-files API: `GET /api/files` (list with size and date), `GET /api/files/read` (preview), `POST /api/files/upload`, `POST /api/files/mkdir`, `DELETE /api/files` |

The app only uses Hermes' public gateway methods. It doesn't patch Hermes.

## Live group input and drafts

Group scheduling is owned by this app (`src/lib/rooms.ts`), with a separate Hermes session for each member. Idle members can answer alongside members already working; the app never starts two turns for the same member session. Your explicit mention or reply to a busy member gently steers that turn. A reply addresses the clicked author even if you edit away their name. Bot-to-bot mentions remain handoffs that wait for the recipient's current turn.

Files sent to a working member are staged into that member's session and submitted as a queued follow-up rather than restarting it. The group's Stop button cancels all live member turns, including session setup and attachment staging. Renaming a group keeps its stable session identity.

Unsent text, selected files and the selected reply recipient stay with their chat when you switch away and back. Drafts are held in memory only: they survive navigation, not closing or reloading the app. Sending clears only that chat's draft. Working animation is limited to the main status icon and the current typing/streaming reply, never historical message icons.

### Answers across a network outage

With the app still running (including in the background), losing its connection does not abandon an accepted group turn. The app retains that member's turn ownership while offline and, on reconnect, reads missed events from the same Hermes session without resubmitting the job. If the bounded replay buffer has gaps or the runtime was rebuilt, it reconciles against the original session's saved transcript instead. Repeated disconnects, queued answers and Stop during recovery have regression coverage.

Only actual assistant answers are published; tool/system transcript rows and unrelated old answers are not. Replay position metadata (session sequence and epoch, not draft text or credentials) is retained across turns. The frontend's idle timer does not interrupt a turn solely because the connection is down.

This is network-outage recovery, not a server-side group scheduler: fully closing or crashing the desktop app is outside this guarantee. It also depends on Hermes retaining the original session and allowing the backend work to continue; it cannot recover an answer that the backend never produced. Nothing in the recovery path changes the bot's profile or model configuration.

Run `bun run test` for desktop-control, group-scheduler and composer regression tests (all of them: `bun test --isolate ./tests/*.test.ts`), and `bun run check` for Electron syntax checks. `bun run build` bundles the renderer without launching or installing the app.

## Native image input

Image routing belongs to each bot's Hermes profile, not to Electron. In current Hermes versions, `auto` mode can prefer an explicitly configured `auxiliary.vision` model even when the main model accepts images. That gives the main model a text description instead of the image.

For a vision-capable main model, explicitly select native input on the Hermes machine:

```sh
hermes --profile default config set agent.image_input_mode native
```

Replace `default` with the bot's profile name. Start a fresh chat so its cached configuration is renewed. Keep auxiliary vision configured if other bots need it; use `text` for a non-vision main model.

Uploaded pictures use Hermes' `image.attach_bytes` path. A screenshot saved as a file still needs an image-loading tool. In native mode, `vision_analyze` can load that image directly into the main model's context; the tool name alone does not mean an auxiliary model analyzed it. A native result attaches the image, whereas an auxiliary result returns a text analysis.

## Computer control

A bot's **Computer** tab has two views, switched with the small icon toggle at its top right: the bot's own computer (server icon) and **This PC** (monitor icon).

### The bot's computer

Each bot can have a small private desktop (TigerVNC + Xfce) on the Hermes machine that its computer-use tool drives. The tab shows a small live, view-only preview of it with a tiny status dot (green live, amber connecting, red you're in control). Hover the preview (or Tab to it) and an **Open** button fades in; clicking anywhere on the preview opens it.

- **Open** expands the screen to a large view over the app window, below the title bar so the window's own minimize / maximize / close stay visible and clickable. The screen keeps its aspect ratio and fills the window along one side (thin bars only on the other), and it follows the window as you resize it. The remote resolution is not changed.
- While it is open **you're in control** (the status dot turns red): the app takes Hermes's control lease for you (`display.lease.acquire`), so the bot knows you have the screen, and your mouse and keyboard go straight to the desktop (paste works too). Hermes only forwards input from the viewer holding the lease, so if control can't be taken the view says so instead of silently staying view-only.
- **Minimize** (the arrows-pointing-in button at the top right, just left of the window controls) shrinks it back to the preview and gives control back to the bot (`display.lease.release`). Leaving the tab or switching bot does the same. If someone else takes the screen while you have it open, the view minimizes.
- **Esc:** a normal tap goes to the bot's desktop (sent once as key down + key up, on release; key autorepeat is ignored). **Hold Esc for about a second** to minimize instead; then nothing is sent to the desktop. A small "Hold Esc to minimize" hint shows near the button for a few seconds after opening and fills up while you hold. If you don't have control at that moment, a tap just minimizes.
- **Paste** from this computer while you're in control. The app reads your clipboard, hands it to the bot's VNC server (TigerVNC puts it on both the CLIPBOARD and PRIMARY selections), then presses a paste key on the bot's desktop. This only happens while the remote screen has focus; in the app's own fields (the sign-in banner's reason box, the composer) Ctrl+V pastes there as usual:
  - **Ctrl+V** is sent as **Shift+Insert**, the X11 paste key, so it pastes in terminals (xfce4-terminal, xterm) as well as in GTK/Qt apps and browsers.
  - **Ctrl+Shift+V** and **Shift+Insert** are sent as you pressed them.
  - Text only, up to about 255 KB (the server's limit). Copying from the bot's desktop back to this computer isn't possible: Hermes starts the VNC server with `-SendCutText=0` so a watcher can never read the clipboard of whoever is in control.
- Starting the computer is a button when it's off; the bot can also start and stop it itself.

### This PC

The **This PC** view lets a bot work on your own Windows machine.

- It is **off every time the app starts**. Nothing runs, not even a screenshot, until you switch it on.
- Press **Ctrl+Alt+Esc** from anywhere to cut access immediately.
- The app runs a small MCP server on a loopback port, forwards it to your Hermes over the same tunnel, and registers it as `hermes-bots-this-pc` on each bot's profile. You can switch it off per bot under **Settings → Connected apps**.
- Screenshots come from Electron's `desktopCapturer`; mouse and keyboard use a PowerShell helper that calls `SendInput`.
- With control on, a bot still asks in the chat before each action that uses your mouse, keyboard, or terminal (move, click, drag, scroll, type, keys, a command). Looking at the screen doesn't ask. See [Approvals](#approvals).
- The preview shows the last screenshot a bot took. Hover it (or click anywhere on it) for **Open**, which shows it large, the same way as the bot's computer; minimize it with the corner button or a plain **Esc** tap (there's nothing to send keys to, so no hold is needed). It's a picture of your own screen, not a stream, so there is no control to hand over: Allow / Stop, the approvals and Ctrl+Alt+Esc work exactly as before, and turning control off closes the large view.

Only enable this for bots and models you trust, and read their approval settings first.

## Approvals

When Hermes stops a bot before something risky, the chat shows a card instead of the action quietly running or failing. That covers dangerous shell commands (`rm -rf`, force pushes, …), Hermes's own `computer_use` desktop actions, writes to protected files such as SSH settings, and tools a plugin or an MCP server marked `trust: untrusted` flags.

- The card says which bot is asking, the command or action, and Hermes's reason. The buttons are the ones Hermes offers for that request: **Allow once**, **Allow for this chat**, **Always allow** (adds it to the bot's allow list) and **Deny**. When Hermes's smart check flagged it, only Allow once and Deny show.
- Desktop actions ask one at a time. **Allow for this chat** covers that kind of action (clicks, typing, …) for the rest of the chat; anything else still asks.
- After you answer, the card shrinks to a line that stays in the chat, like "Allowed once: rm -rf build" or "Denied: …".
- In a group the card shows in the group, under the bot that asked. The rules are the same as in a 1:1 chat.
- While a bot waits, its row in the sidebar says **Needs your OK** (a group's row names the bot), and a short notice pops up if you're in another chat.
- If Hermes stops waiting (it timed out, you pressed stop, or the turn ended), the card is marked expired and its buttons switch off.

Whether a bot asks at all is its **Approvals** setting (ask me / smart / never ask), which is Hermes's `approvals.mode`. How long Hermes waits is `approvals.timeout` in the bot's Hermes config (5 minutes by default).

**This PC** actions ask too. Hermes only stops MCP tool calls on a server marked `trust: untrusted`, so each time the app registers `hermes-bots-this-pc` on a bot's profile it also sets `mcp_servers.hermes-bots-this-pc.trust: untrusted` in that profile's config (`PUT /api/config`, which merges in that one key and leaves everything else alone). The PC server marks `computer_screenshot` read-only, so Hermes lets it run straight away. Every other This PC tool asks first.

- The card names the action and where, from the tool call the bot just made: "Click at (812, 604)", "Type "Q3.docx"", "Press ctrl+c".
- **Allow for this chat** covers only that kind of action (clicks, typing, key presses, …) in that chat. There's no **Always allow**, since Hermes doesn't keep a grant for these.
- No answer before Hermes's `approvals.timeout` means no: the card expires and the action doesn't run.
- While **Allow control** is off, the app answers no straight away without showing a card. The record reads "Denied (control is off): …". Switching control off, or pressing Ctrl+Alt+Esc, denies any card that's still waiting and forgets that chat's **Allow for this chat** choices for This PC.
- The This PC tab warns you if Hermes couldn't be set to ask first. Bots can then act without asking while control is on.

For any other MCP server marked untrusted, every call asks, and **Allow for this chat** stops asking for that server in that chat. The app remembers this, since Hermes doesn't keep a grant for these.

## Memory

Each bot has Hermes's built-in memory: two short files in its profile that its `memory` tool writes and that Hermes reads into the bot's instructions when a chat starts.

- **Settings → Memory** (or **Memory** under Setup in the side panel) shows both: **Notes** (`MEMORY.md`, the bot's own notes) and **What it knows about you** (`USER.md`). Add, edit or delete any entry. The counter shows Hermes's size limit for that file (`memory.memory_char_limit` / `memory.user_char_limit`, 2,200 and 1,375 characters by default), and the app won't save past it.
- **+ → Shared memory** is one list of facts about you that every bot knows. Add your name, time zone or how you like answers, and each bot gets the list in its team directory on its next message. Each fact says who added it.
- Bots add to it themselves. The directory tells each bot to save facts about you with its memory tool (target `user`). After a bot's turn, the app copies new `USER.md` entries into shared memory, so a fact one bot learns reaches the rest. Editing or deleting a shared fact also changes the bots' own copies, and a deleted fact isn't copied back in.
- Hermes keeps a chat's instructions as they were when the chat started, so a long chat wouldn't see a change you make to a bot's files. The app also lists your recent edits in that bot's team directory, which every one of its chats gets on the next message.

Limits: the app edits the files the way Hermes's file API does (a fresh read, then an atomic write), without the lock Hermes's own memory tool takes, so a save made at the very same moment as the bot's could lose one of them. The file API runs on the Hermes machine's own disk; if Hermes is set to run its tools somewhere else (an SSH or container backend), it may look in the wrong place. A bot whose Memory tool is switched off can't add shared facts, and is told to ask you instead. The first time it syncs, the app copies everything already in each bot's `USER.md` into shared memory.

## Routines

A routine is a task a bot does by itself, on a schedule ("Weekdays at 9:00 AM") or once ("Once, Fri, Oct 9 at 6:00 PM"). Routines are Hermes cron jobs in that bot's profile, so they run even when the app is closed, as long as Hermes's scheduler is running.

- **Settings → Routines** (or **Routines** under Setup in the side panel) lists each routine with its schedule in plain English, the next run in your local time, how the last run went, and whether it's paused. You can **Pause**/**Resume** it, **Run now**, **Edit** it (the pencil), or delete it (after a confirm).
- **New routine** asks what to do, when (every day, weekdays, a weekday, hourly, a custom cron expression, or once at a date and time) and which bot runs it.
- **Edit** opens the same form, filled in from Hermes's own copy of the routine: the whole prompt, the name, and the schedule. A schedule that matches one of the choices selects it. Anything else shows under Custom as Hermes wrote it, and a one-time routine shows its date and time. **Save changes** sends only what you changed, through Hermes's cron update (`PUT /api/cron/jobs/{id}`, the same update the `cronjob` tool's `update` action does). The routine keeps its id, its run history and its delivery, so a `bot-chat` routine still reports to your chat. A paused routine stays paused. The bot that runs it can't be changed here: add it to the other bot and delete this one. Finished one-time routines have no Edit.
- Results come back to your 1:1 chat with that bot. The app creates routines with Hermes's `bot-chat` delivery: the output arrives in the bot's chat as a short "Routine … ran" card you can open, followed by the bot's own summary. A routine whose delivery is something else (for example `local`, which only saves the output on Hermes) says so on its card.
- Bots know they can do this. If a bot's **Scheduled jobs** tool is on, its team directory tells it to create routines with `cronjob_manage` and `deliver="bot-chat"`.

Repeating times run on Hermes's clock: its `timezone` setting, or the Hermes machine's own time zone when that isn't set. If that isn't your time zone, the card says "(Hermes time)" and the form says which zone it uses. One-time routines are sent with your UTC offset, so they run at the time you picked. If Hermes says its scheduler isn't running, the Routines list shows that warning.

## Group posts

A bot can post into one of its groups from your 1:1 chat with it. Say "tell the launch group we're moving to Monday and ask Forge to hold the release branch", and the message shows up in that group as the bot's, marked **from 1:1 chat**.

- It's a real tool, not text the app looks for in replies. The app runs a second small MCP server on the same loopback port as This PC and registers it as `hermes-bots-groups` on every bot's profile, each with its own address and token, so the app knows which bot is posting. Its tools are `post_to_group(group, text)` and `list_groups()`. You can switch it off per bot under **Settings → Connected apps** (it shows as **App tools**, and the same switch covers [profile edits](#bots-editing-their-own-profile)).
- The group then runs as if the bot had said it there: teammates it @mentions are asked to answer, following the group's rules. A bot you paused with `@bot stop` (sticky mode) isn't woken, and can't post there itself until you @mention it again. Nobody else is woken, the same as when a bot speaks in a group. The group's turn limit caps the chain of replies.
- No loops: the poster isn't woken by its own post, and a bot taking a turn in another group can't post there. In its own group a bot can post an intermediate step mid-turn; its reply still posts when the turn ends. Each bot can post at most 3 times a minute, and a group takes at most 8 of these posts in 10 minutes.
- A bot can only post to groups it's a member of. Its team directory names the tool and lists those groups (only when the tool is on for that bot). When the bot next speaks in that group, its own post is part of what it reads, since that group chat never saw it.
- Approvals are unchanged: the server is registered without `trust: untrusted`, the same as This PC, so Hermes doesn't ask before a post.

## Reactions

Messages can carry emoji reactions, shown as small pills under the bubble, in 1:1 chats and groups.

- **You react to a bot's message:** hover it and click the smiley button, then pick from the quick row (👍 ❤️ 😂 🎉 ✅ 👀 🙏 🔥 😮 😢). Clicking your pill (or the same emoji again) removes it; a different emoji replaces it. One reaction per person per message. The bot isn't woken for it: it gets a short note with its next message, e.g. `[The user reacted 👍 to your message "Checked the repos…". No reply is needed for this.]`.
- **A bot reacts to your message** with the app's `react_to_message` tool (on the same `hermes-bots-groups` MCP server as `post_to_group`): `{ message_id, emoji, end_turn? }`. Bots see an id for each of your messages: `Message id: u…` in the hidden context of each 1:1 message, `[g…]` before each line of a group prompt. A reaction can be the whole reply (for a "thanks" or "ok"): a turn that only reacted shows no empty bubble, and in a group the bot replies `(pass)`. Bots can't react to their own messages.
- **Groups:** hover a pill to see who reacted (You, Nova, Scout…).
- **Saved:** group reactions are stored with the group's log (and synced with it). 1:1 history comes from Hermes, which has no place for reactions, so they're kept on this device.

## Question buttons

A bot can ask you something with clickable options instead of making you type, using the app's `ask_user` tool (on the `hermes-bots-groups` MCP server):

```
ask_user { prompt, options: [{ label, value?, description?, style?: "default" | "primary" | "danger" }] (1-6), allow_custom?, multi_select? }
```

- It shows as a card in the chat the bot is in: its 1:1 chat, or the group it's answering in (anyone in the group view can answer as you).
- Clicking an option sends its `value` (or its label) as your reply, marks it as chosen and locks the card. In a group, only the bot that asked is woken by the answer.
- `allow_custom` adds a small text box for your own answer; `multi_select` lets you tick several and press **Send** (values one per line).
- If you type a normal message instead, any open card is marked *Not answered*. A new question from the same bot also replaces its open one.
- The tool tells the bot to end its turn after asking; your answer arrives as your next message.
- Saved like reactions: group cards live in the group's log (and sync with it); 1:1 cards are kept on this device.

## Secrets

A bot that needs an API key, token or password asks for it with the app's `request_secret` tool (`hermes-bots-groups`): `{ name, label, description? }`, where `name` is an env var name (`[A-Z_][A-Z0-9_]*`, e.g. `OPENAI_API_KEY`).

- A **masked card** appears in the bot's 1:1 chat (label, description, show/hide eye, Save / Cancel). In a group the input is **never** shown: the group only gets a note "Open your 1:1 with <bot> to enter this", and the card is in the 1:1 chat.
- **Save** sends the value straight to Hermes's own credential API, `PUT /api/env?profile=<bot>`, which writes it into that bot's profile `.env` (same name replaced, other keys kept; Hermes keeps the file at `0600`). The value never goes into a chat message, the model's context, the app's logs or localStorage, or a group log. The card then shows **Saved** (no value), and the bot gets the message `[Secret OPENAI_API_KEY saved. It's available as an environment variable; the value is not shown.]`.
- **Picking it up:** after a save or delete the app asks the gateway to re-read the env (`reload.env`), so new tool runs usually see it right away. If a bot still can't see a new variable, start a new chat (or restart Hermes). Hermes hides its own provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) from terminal commands unless they're listed in `terminal.env_passthrough`; custom names (e.g. `STRIPE_READONLY_KEY`) are passed through.
- **Bot Details → Secrets** lists the names set in the bot's profile (never values) and lets you delete one.
- **Pasted-key guard:** if a message you're about to send looks like an API key (`sk-…`, `ghp_…`, `github_pat_…`, `AKIA…`, `xox…`, `AIza…`, `hf_…`, `xai-…`), the composer holds it and offers **Save as secret** (1:1 chats, with a suggested name), **Send anyway** or **Edit**.

## Sign-in handoff

When a bot hits a login, 2FA, captcha or any step only you can do on its computer (the Sandbox desktop), it leaves the screen at that step and hands it over with the app's `request_user_help` tool (`hermes-bots-groups`): `{ instruction, url?, done_label? }`.

- A card appears in the bot's 1:1 chat with the one-line instruction and **Open screen**. In a group, the group only gets a note pointing to the 1:1 chat.
- **Open screen** switches to the bot's Computer tab and opens the large view with you in control (the same lease as the Open button). If the computer is off, the card says so and the button reads **Start & open screen**: it starts the computer first.
- A thin banner in the strip above the screen shows the instruction (and the URL, if given) with **Done** (or the bot's `done_label`) and **Can't do it** (with an optional reason). Either one minimizes the view, hands control back and tells the bot: `[The user finished: <instruction>. You have the screen back.]` or `[The user couldn't finish: <instruction>. Reason: …]`. Minimizing without pressing either leaves the card open, so you can come back to it. Can't do it also works from the card.
- The tool tells the bot to end its turn and wait for that message.
- Cards are kept on this device, like the other cards.
- **This PC** isn't involved: it's your own computer, so there's nothing to hand over.

## Several machines

The app can be connected to several Hermes hosts at once and lists all their bots together.

- **Settings → Machines** lists every host with a status dot (green online, yellow connecting, red offline). From there you can:
  - **Add a machine** the same three ways as the Connect screen: this computer, a server URL + session token, or SSH.
  - **Rename** a machine (double-click its name or use the pencil), **Retry** an offline one, or **remove** an added one. Removing one deletes nothing on that machine.
  - Pick **Use for new bots** to set the default machine for new bots. The New bot dialog and template import also have a **Machine** choice.
- **Storage:** added machines are saved like the first connection, in the app's settings file with tokens sealed by the OS keychain (`safeStorage`).
- **Migration:** your existing connection becomes the **main** machine, so nothing changes until you add another.
- **Sidebar:** with more than one machine, each bot shows a small machine badge. The connection menu at the bottom lists each machine's state and has **Group bots by machine**.
- **Offline machines:** their bots show greyed with "machine offline", and their chat says so. In group chats an offline member sits the turn out, with a line saying so.

**How routing works.**
- **Bot names:** a bot on an added machine is called `<profile>@<machine id>` inside the app (ids look like `hb7k2q9x`), so two machines can each have a `default` or a `forge`. Main-machine bots keep their plain names.
- **Separate links:** every machine gets its own gateway socket.
- **Routing rule:** each gateway request and HTTP call is checked for a `@<machine id>` name.
  - A call that names a bot on an added machine goes to that machine, with the suffix taken off.
  - A call for a session started there goes there too.
  - Everything else goes to the main machine.
- **What follows:** chats, the Computer tab, routines, memory, secrets, files from bots, templates, model picks and approvals all reach the bot's own Hermes. Events and approval requests from every machine arrive in the same app.
- **This PC and the app's own tools** (`hermes-bots-groups`) are registered on each machine reached over SSH (through its own reverse tunnel), under the bot's app name.

**Group chats.**
- **Mixed members:** a group can include bots from different machines. Each member's turn runs against its own machine (its hidden room session lives there).
- **Where the log lives:** the group list and its synced log stay on the main machine (the `default` profile's `ui_meta`, as before), and the full log stays on this device. So a group's home is always the main machine.

**Not included.** Moving a bot to another machine is out of scope. Export it as a template and import it on the other machine instead.

## Switching models mid-chat

The pill next to the chat title shows the model this chat uses (for example `MiniMax-M3.1-Flash`). Click it, or press **Ctrl+Shift+M**, to pick another.

- **Which models.** The list comes from the providers connected on that Hermes (`model.options`, the same list as Details > Model). Search filters it, and providers that aren't connected are greyed out.
- **What a pick changes.** Only this chat, from the next message on. A line in the chat says "Switched to <model>". If a reply is running, Hermes applies the pick at the next turn.
- **Thinking.** A row of thinking levels appears when Hermes's capability catalog says the model takes one.
- **Set as bot default** writes the pick to the bot's profile, exactly like Details > Model, so every chat with that bot uses it. **Use bot default** drops the chat's pick.
- **Groups.** The **Models** pill lists every member with its model. Pick a bot to change its model in this group only. Its 1:1 chat and other groups keep theirs.

**How it works.** It uses Hermes's own per-session `/model` override, the one its desktop composer uses:

- **Model:** `config.set {key: "model", value: "<model> --provider <slug> --session", session_id}`.
- **Thinking:** `config.set {key: "reasoning", scope: "session", session_id}`.

Hermes keeps the override on that session only. It never writes the profile or affects other chats. Hermes can drop the override in two cases:

- **Groups:** a group member's session is rebuilt from the profile when it's resumed.
- **Profile change:** a bot chat follows the profile, so changing the bot's default model clears the chat's pick.

To cover both, the app remembers each chat's pick on this device and pins it again whenever the session is resumed.

## Templates

Share a bot's setup as a file, and make new bots from one.

- **Export.** Bot menu (sidebar ⋯ or the Details panel) → **Export as template** saves `<bot>.hermesbot.json`. Two options: **Bundle custom skill files** (on: text files of skills this bot has that the main bot doesn't, up to 256 KB per skill) and **Include memory notes** (off: the bot's own `MEMORY.md`; `USER.md`, what it knows about you, is never included).
- **Import.** **New bot → From template…**, or drop a `.hermesbot.json` anywhere on the app. A preview card shows the name, face, model, tools, skills, apps, routines and the secrets it needs. Pick a name and a profile name, then **Create bot**; progress is shown step by step. Anything that can't be applied (a model whose provider isn't connected here, a skill that isn't installed) is a warning, not a failure. Each required secret then waits in the new bot's chat as a secure secret card, the same one `request_secret` uses.
- **Duplicate bot** (same menus) is export → import in one step, without a file: same setup, new profile, no chats or memory.

**File format** (`format: "hermes-bot-template"`, `version: 1`):

| Key | What |
|---|---|
| `bot` | `name`, `display`, `label`, `description`, `color`/`shape`, `avatar` (a small embedded webp, at most 160 px) |
| `persona.soul` | The profile's `SOUL.md` |
| `model` | `provider` and `model` names (no keys), `reasoning` |
| `approvals` | `manual` / `smart` / `off` |
| `toolsets` | `pinned`, `enabled` toolset names |
| `skills` | `enabled`, `disabled` names; `bundled: [{name, files: [{path, text}]}]` |
| `mcpServers` | Name → `{url \| command, args, env, headers, auth, enabled, tools}`. Every secret is a `${VAR}` placeholder |
| `routines` | `{name, prompt, trigger: {kind: "schedule", schedule} \| {kind: "github", events} \| {kind: "webhook"}, paused}` |
| `memory` | Optional: `{notes}` (MEMORY.md) |
| `requiredSecrets` | `[{name, label, usedBy}]`: the placeholders the importer has to fill |

**Never in a template:** `.env` values, API keys, tokens, OAuth sign-ins, provider credentials, chat history, `USER.md`, webhook URLs and HMAC secrets, and the app's own MCP servers (`hermes-bots-groups`, `hermes-bots-this-pc`), which every bot gets anyway. Secrets are replaced as follows:

- **MCP env values:** a value with a secret-sounding name, or anything token-shaped, becomes `${NAME}`. Plain settings like `LOG_LEVEL=debug` stay.
- **Headers:** `Authorization` becomes `Bearer ${MCP_<SERVER>_TOKEN}`.
- **URLs and arguments:** secret query parameters, a value after a flag like `--token`, and user:password in a URL are replaced too.
- **Final scan:** the finished file is scanned with the pasted-key patterns from the composer guard (OpenAI, Anthropic, OpenRouter, GitHub, AWS, Slack, Google, xAI, Hugging Face) plus private keys, bearer tokens, JWTs, Stripe and GitLab tokens, and passwords in URLs. Anything found becomes `[removed]` and is listed in the dialog.
- **Imported files** are scanned the same way. Bundled skill paths can't contain `..` or be absolute.

**How import works.**

- `profiles.create` clones the main bot, so the new bot gets this Hermes's own provider credentials and built-in skills.
- The model is set through `profiles.configure`, and `config.set` sets thinking and approvals.
- MCP servers are deep-merged into the profile with `PUT /api/config`. Hermes resolves `${VAR}` from the bot's `.env` when it launches a server.
- Bundled skills and memory are written with `/api/files/upload`.
- Routines are recreated. Event routines get new URLs (and no secret), so set them up again wherever the events come from.
- OAuth MCP servers need a fresh sign-in.

## Voice

- **Voice notes.** The mic in the composer (shown while the box is empty): hold it to talk and release to send, or click to start and click send (or Enter) to finish. Esc or × cancels. While recording it shows a timer and a live waveform (5 minutes max).
- **Transcription.** The recording is transcribed by **Hermes's own speech-to-text** (`POST /api/audio/transcribe`, the pipeline Hermes uses for Telegram/Discord voice memos and its desktop voice mode), with the bot's profile so its `stt` provider applies (local faster-whisper by default; or OpenAI, Groq, Mistral, xAI, whisper.cpp, a command). In groups, the first member's profile is used.
- **What's sent.** The bot gets the transcript, after a line saying it was a voice note, plus the recording as an attachment. In chat it shows as a voice bubble (play, scrub, time) with the transcript under it. If Hermes can't transcribe it (no STT set up, or an older Hermes), the note still goes with the audio attached and a line telling the bot to transcribe it with its own tools.
- **Spoken replies.** Bots have `send_voice_memo {text}` (on `hermes-bots-groups`). The app has **Hermes's own text-to-speech** (`POST /api/audio/speak`, the bot's `tts` provider; Edge TTS is the free default) make the audio, saves it to the shared folder (`voice-memos/`), and posts it like `send_file` with `voice`. It shows as a voice bubble with the text as its caption, in 1:1 chats and groups.
- **Read aloud.** Every bot message has a speaker button that reads it with this computer's voices (Web Speech API); click again to stop. No setup.
- **Settings → Voice.** Pick the microphone and the read-aloud voice (with a Try button).
- **Permissions.** Electron grants the microphone (audio only) to the app's own page; camera and screen requests from it are refused. macOS asks the system first.
- **Limits.** Voice notes are kept on this device (like other attachments), so another computer shows the transcript only. Bot voice memos are files on the Hermes machine.
- **Demo.** `#chat-voicerecord` shows the recorder; `#chat-voice` shows a voice note and a voice memo.

## Event routines

A routine can run when something happens, not just on a timer. In New/Edit routine, set **When** to **Event**.

- **GitHub:** pick the events (PR opened, PR merged, push, issue opened, or any). Optionally add a webhook secret; the app checks GitHub's `X-Hub-Signature-256` with it. The secret is encrypted on this computer (Electron safeStorage) and never shown in chat.
- **Webhook:** any POST runs the routine.
- **Email:** coming soon. Hermes reads email as a chat platform, but nothing can start a routine from an email yet.
- **When it fires:** the request body is added to the routine's prompt for that run (pretty-printed if it's JSON, cut at 4,000 characters). The result arrives in your 1:1 chat with the bot, like a timed routine.
- **Each event routine** has a secret URL (`http://<host>:8648/hooks/<token>`) with **Copy** and **Send test event** (a real, signed POST to itself), and shows when it last fired. In the routines list it has a ⚡ instead of a clock.

**How it works.** The routine is still a Hermes cron job delivering to `bot-chat`, parked on a schedule that never comes due (`every 36500d`). The URL is served by **this app** (`electron/hooks.cjs`). When a POST passes the checks, the app runs the job through Hermes (`POST /api/cron/jobs/{id}/trigger`). For that one run the event is appended to the job's prompt and removed again afterwards; runs of the same routine queue.

**Reachability.** The app must be running, and the sender must be able to reach this computer. By default the listener only accepts connections from this computer (127.0.0.1). **Accept from other machines** in the listener settings opens it to your network. GitHub can't reach either without a tunnel such as cloudflared or ngrok pointed at the port.

Hermes has a native webhook platform that can fire a cron job (a route with `cron_job`) without the app running. Its dashboard API can't create such routes yet, so to use it, run `hermes webhook subscribe <name> --cron-job <routine id> --events pull_request` on the Hermes host.

## Search

Search every chat at once. Click the magnifier at the top of the sidebar, or press **Ctrl+K** (anywhere) or **Ctrl+F** (when you're not typing in a field).

- **What it searches:** message text in every bot's 1:1 chat and every group, thread replies, names of attached and sent files, and card prompts (questions with their options, secret-request labels, sign-in instructions). Hidden context (message ids, team info) is never searched, and secret values never reach chat in the first place.
- **Results:** grouped by chat, with the bot or group face, who wrote it, a snippet with the match highlighted, and the time. Matching ignores case and accents, and every word you type must appear. Use **↑/↓** and **Enter**, or click. The app opens that chat, opens the thread pane if the result is a thread reply, and scrolls to the message with a short highlight.
- **Filters:** one chat, and **Everyone / From me / From bots**.
- **How it stays fast:** typing is debounced, and results come from what the app holds in memory. Each chat's searchable text is built once per change and reused while you type. For bot chats that aren't open yet, the app asks Hermes's full-text search (`/api/sessions/search`, per bot) which bots have a match and loads only those chats, three at a time. On a Hermes without that endpoint, it loads all of them.

## Threads

A reply can sit under one message, so long digests and side questions don't flood the chat. This works in 1:1 chats and groups.

- **You:** hover a message and click **Reply in thread**, or click a root's **N replies** link (it shows the last reply time and who replied). A thread pane opens on the right with the root, its replies and its own composer. Esc or × closes it. Thread replies don't appear in the main timeline. Reactions, question cards and files work inside threads as well.
- **What the bot sees:** a 1:1 message you send in a thread reaches the bot with `[In thread on message <id>: "<root excerpt>"]`, and its answer lands in the same thread. In a group, thread messages are marked `(in thread on g…)`. The reply from that turn goes into the thread, and a thread reply that @mentions nobody goes to the bot that wrote the root.
- **Bots:** `reply_in_thread { message_id, text }` on `hermes-bots-groups` posts a threaded reply. Bots are told not to repeat it in the main reply. `post_to_group` takes an optional `reply_to` (a `g…` id). Ids are the ones bots already see for reactions: `u…` for your messages in a 1:1 chat, `b…` for a bot message you've threaded on, and `g…` in groups.
- **Always the root:** replying to a reply attaches to the same root.
- **Stored:** group threads are part of the group log, so they sync (`threadOf` on the entry). In a 1:1 chat, the thread a message belongs to is kept in its hidden context in Hermes's transcript. The bot's `reply_in_thread` posts are kept on this device.

## Files from bots

Charts, images and documents a bot makes show up as attachments, in 1:1 chats and groups. The bot calls the app's `send_file` tool (`hermes-bots-groups`): `{ path, caption?, filename? }`, where `path` is the file's full path on the Hermes machine.

- **Checks:** the path must be absolute, with no `.`/`..` segments, and can't be a credentials file (`.env`, SSH keys, `*.pem`/`*.key`, `.aws`/`.ssh`/`.gnupg`…). The file must exist (looked up through Hermes's `/api/files` listing) and be at most **50 MB**. Hermes's own managed-files policy (allowed roots, sensitive-file denylist) applies on top when the file is read.
- **In chat:** the caption shows as text, then the file. Images show inline (click for the full-size lightbox). Video and audio up to 25 MB get a Play button and an inline player. Everything else (pdf, csv, xlsx, docx, zip…) is a chip with name, size and type, plus **Download** (a Save dialog) and **Open** (saved to a temp folder, then opened with your default app). A turn that only sent a file shows no empty bubble.
- **Lazy:** a message carries only a reference (path, name, size, type). The bytes come from Hermes (`/api/files/read`) when a picture is shown, a player starts, or you download or open it.
- **Where it goes:** into the group the bot is answering in, otherwise its 1:1 chat. Group posts are saved with the group's log and synced (other members see `(sent the file <path>)`). 1:1 posts are kept on this device.
- **Attaching your own files to a bot** was already there: the composer's **+** button, or drag and drop.

## Bots editing their own profile

Ask a bot "call yourself Atlas from now on" or "set your label to Research", and it changes its own name, label or description. Your chat with it then shows a line like *Nova changed its name to Atlas and its label to Research*.

- It's two more tools on the app's tool server from [Group posts](#group-posts): `get_profile()` and `update_profile({name?, label?, description?})`. Each bot's calls come in on its own address and token, so a bot can only ever change itself. They're under the same **App tools** switch in **Settings → Connected apps**.
- The change goes through the same code the **Edit bot** sheet and the label under a bot's name use. The roster, the side panel and **+ → Team** update right away. Every bot's team directory changes too, so teammates get the new name with their next message.
- Only when you ask. The tool's description and the bot's team directory both say so. The app also refuses unless the bot is answering you in its 1:1 chat at that moment, so a teammate, a group or a routine can't trigger it.
- Rules:
  - A name can't be empty, can be up to 40 characters, needs a letter or number, can't contain `@`, and can't be `everyone`, `all` or `team`.
  - A name can't match another bot's name or @handle.
  - Labels can be up to 40 characters (empty removes it), and descriptions up to 200.
  - Each bot can change its profile 3 times in 10 minutes.
- The name is the app's display name. The bot's Hermes profile (its folder, its id, and what `message_agent` calls it) stays the same, since renaming a profile folder would break its sessions, jobs and connected apps. For non-default bots the group @handle is the profile id, so it stays the same too. The main (default) bot's @handle follows its name, the same as when you rename it yourself.

## Shared folder

**+ → Shared folder** is one folder on the Hermes machine that every bot can read and write: `<Hermes home>/team-shared` (for example `~/.hermes/team-shared`). Hermes uses `<Hermes home>/shared` for its own login tokens, so the team's files stay out of that folder.

- The app creates the folder when it connects. Every bot is told its full path in its team directory, that every bot and you can see the files, and to put files there when it hands work to a teammate with `message_agent`, giving the path.
- The view lists files and folders with size and when they changed. Click a text file to read it, or a picture to see it. **Upload** (or drag files in) adds files without overwriting: a name that's taken gets " (2)". Delete asks first, and a folder goes with everything in it.
- It uses Hermes's managed-files API (`/api/files…`). The `/api/fs` endpoints memory uses can't make folders, upload, delete or report sizes and dates.

## Rich replies

Bot replies render GitHub-style Markdown: headings, lists and task lists, tables that scroll sideways, quotes, and code blocks with syntax highlighting, a language label and a Copy button. Math in `$$ ... $$`, `\[ ... \]` or `\( ... \)` renders with KaTeX, which loads only the first time a reply contains math. Links open in your browser and never replace the app window; raw HTML in a reply is shown as text, not run. Pictures a bot links by their path on the Hermes machine are shown inline. Replies that are still streaming render without flicker, even with an unclosed code block or half a table.

Preview: `#chat-markdown` (every element) and `#chat-mdstream` (a reply still arriving).

## Project layout

```
src/                 React UI (TypeScript)
  lib/               gateway client, chats, groups, attachments, per-bot config
  ui/                screens: roster, thread, panel, library, settings, dialogs
  demo.ts            sample data for the preview mode
electron/            main process, preload bridge, computer-control server
static/              index.html and styles.css (copied into the build)
vendor/novnc/        noVNC (MPL-2.0) for viewing a bot's remote desktop
build.ts             Bun build script → ./app (the packaged app folder)
.github/workflows/   checks on every PR; release.yml builds the Windows installer for v* tags
```

## Known limits

- Connected apps can be switched on and off here; adding a new one is done on the Hermes side (`hermes mcp add`).
- Files you send are kept on the device you sent them from so the Library can preview and re-save them. Chat history that came from another device shows those files by name only.
- A group's message history is stored on the device you chatted from, so a second computer sees the group but not its earlier messages.
- Computer control is Windows only and has had limited testing. Treat it as experimental.
- This PC approvals rely on Hermes's MCP `trust` setting and its config API. The app re-adds the server, then sets `trust`, so a chat that reloads its tools in that split second keeps the old no-ask setting until its next tool reload. Only the This PC tab's warning shows when setting `trust` failed. The card can show where a click lands only when Hermes sends the tool call's arguments (it does when tool progress is on). Otherwise it names the action alone.
- **Edit** and **Run now** use Hermes's dashboard API (`/api/cron/jobs…`), like the rest of the app's REST calls. A Hermes without it can still list, add, pause and delete routines, but not edit them.
- **Run now** waits for the routine to finish, since Hermes runs it before answering. After 15 minutes the app stops waiting, but the routine keeps running on Hermes.
- Memory editing doesn't take Hermes's file lock, and follows the launch profile's tool backend (see [Memory](#memory)).
- Group posts go through the app, so the app has to be open. The bot gets an error otherwise. Like This PC, group posts are only set up when the app started Hermes or connects over SSH. They aren't set up for a Hermes it found already running or a remote server address. If two copies of the app use the same Hermes, the one that connected last receives the posts.
- A bot's identity for group posts and profile edits is the address and token registered on its profile. A bot that can read other profiles' Hermes config on disk could post as, or rename, another bot.
- Profile edits only work while the bot is answering you in its 1:1 chat in this copy of the app (a chat running on another device doesn't count). The "changed its name" lines are kept on this device only.
- Markdown: math needs `$$ ... $$`, `\[ ... \]` or `\( ... \)`; single `$` is left as text so prices aren't mangled. Mermaid diagrams show as code. Code in languages outside the common set (shell, Python, JS/TS, Go, Rust, C/C++/C#, Java, SQL, JSON/YAML/TOML, HTML/CSS, diff, Dockerfile, PowerShell, Markdown) isn't coloured. Pictures linked by a path on the Hermes machine load through its managed-files API (up to 8 MB), so they don't show for a Hermes without it.
- The shared folder is on the Hermes machine's own disk. A bot whose tools run somewhere else (an SSH or container terminal backend) won't see it at that path. Uploads are limited to 25 MB each, and previews to text up to 1 MB and pictures up to 8 MB. On a hosted Hermes whose file browser is locked to one folder, the shared folder must be inside it (it is when Hermes home is that folder).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and report security problems privately as described in [SECURITY.md](SECURITY.md).

## Code signing policy

Windows releases of NexurBots are signed once the project's SignPath Foundation application is approved. Until then, releases are unsigned, and the README's install steps explain what Windows will show.

- **Certificate:** issued by SignPath Foundation. Signing is done by SignPath.io.
- **Team roles:**
  - **Authors** (may change the source without further review): [@nexurlabs](https://github.com/nexurlabs) and [@rishabhiskawai](https://github.com/rishabhiskawai).
  - **Reviewers** (review every pull request from anyone else before it is merged): [@nexurlabs](https://github.com/nexurlabs) and [@rishabhiskawai](https://github.com/rishabhiskawai).
  - **Approvers** (approve each signing request in SignPath before a release is signed): [@nexurlabs](https://github.com/nexurlabs).
- **Build:** releases are built from the public source by the GitHub Actions workflow in this repository. Only tagged commits on `main` are released.
- **Privacy:** this program does not transfer any information to other networked systems unless the user or the person installing or operating it requests that. NexurBots connects only to Hermes instances the user configures.

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## License

MIT. See [LICENSE](LICENSE). noVNC in `vendor/novnc` is MPL-2.0; its license is included alongside it. Credits and third-party notices are in [NOTICE](NOTICE).

### Team awareness

Every bot knows the team. With each turn (1:1 and group) it gets a short directory from the app: itself (name, Lead, label, model, machine), each teammate (label, model, role, what it's good with, groups), its own groups and their members, a reminder that 1:1 chats are private, how to hand work over with Hermes's `message_agent`, the shared folder's path, how to post into its groups (when that tool is on), and a one-line *now* with the user's local time and who is busy. The full directory is only resent when it changes, so prompts stay small, and it's stripped back out of the chat view. **+ → Team** shows the same picture with live status.
