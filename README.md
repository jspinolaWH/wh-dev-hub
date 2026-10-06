# WasteHero Dev Hub

Persistent Claude Code sessions on an always-on host PC, controlled from a
branded desktop app. Sessions live in the **daemon** (server), so they survive
laptops going home, wifi drops, and the client app closing entirely.

```
┌────────────┐  WebSocket (over Tailscale/VPN)  ┌──────────────────────────┐
│ Electron   │ ────────────────────────────────▶│ Daemon (office PC)       │
│ client app │   attach / type / resize / kill  │  · node-pty sessions 24/7│
│ (any PC)   │ ◀────────────────────────────────│  · scrollback replay     │
└────────────┘   output stream + session list   │  · per-user Claude login │
                                                │  · port/env presets      │
                                                └──────────────────────────┘
```

## Dev (both on one machine)

```
npm install
npm run daemon    # ws://127.0.0.1:7811, data in daemon/data/
npm run app       # Electron client (vite dev + HMR)
```

The daemon prints its data dir; `daemon/data/config.json` holds everything:

```jsonc
{
  "host": "127.0.0.1",          // set 0.0.0.0 (or the Tailscale IP) on the office PC
  "port": 7811,
  "tokens": {                    // token -> username; Slack sign-in will issue these
    "<random>": "dev",
    "<random>": "joao"
  },
  "inheritHostClaudeLogin": ["dev"],  // these users reuse the host's claude login;
                                      // everyone else gets an isolated profile under
                                      // data/profiles/<user>/claude (log in once, in-terminal)
  "presets": [ ... ],            // one-click environments, see below
  "scrollbackLines": 10000,      // per session, restored in full when you open a chat
  "github": { "token": "…" },    // optional: PR status in a chat's Pull requests panel
                                 //   (else GITHUB_TOKEN / GH_TOKEN, else the host's `gh` login)
  "linear": { "apiKey": "…" }    // optional: the Linear task each PR is attached to
}
```

## Presets (one-click environments)

A preset allocates ports from ranges, substitutes `${NAME}` into cwd/command/
env/links, exports each port as env var `NAME`, and shows the links on the
session card. Ports are freed when the session exits.

```jsonc
{
  "id": "wh-stack",
  "name": "WasteHero full stack",
  "description": "New git worktree + BE/FE on free ports + DB cloned from golden dump",
  "cwd": "C:/Users/drasm/Desktop/wasteheroRepo",
  "command": "powershell -NoProfile -File scripts/new-stack.ps1 -BePort ${BE_PORT} -FePort ${FE_PORT}; claude",
  "ports": {
    "BE_PORT": { "from": 5100, "to": 5199 },
    "FE_PORT": { "from": 3600, "to": 3699 }
  },
  "links": [
    { "label": "Frontend", "url": "http://127.0.0.1:${FE_PORT}" },
    { "label": "API", "url": "http://127.0.0.1:${BE_PORT}" }
  ]
}
```

The `new-stack.ps1` script (per repo, not part of this project) does the
WasteHero-specific work: `git worktree add`, write env files with the ports,
`createdb --template golden_db`, start docker. The daemon doesn't need to know
any of that — it just runs the command with the ports it allocated.

## Ownership model

Everyone signed in sees all sessions and may **attach read-only**; only the
session's owner can type, resize, kill, or remove it.

## Using the hub

Each chat card shows live status: a spinner while it works, a pulsing amber
dot when it **needs you** (a permission prompt or question on screen, or a
bell), and a blue dot when something happened while you were elsewhere. The
window title counts chats that need you.

| Shortcut (⌘ on a Mac) | |
|---|---|
| `Ctrl+K` | jump to any chat, or run a command (split view, text size, …) |
| `Ctrl+N` / `Alt+N` | new chat |
| `Alt+↑` / `Alt+↓` | previous / next chat |
| `Ctrl+F` | find in the chat (Enter / Shift+Enter step through matches) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | bigger / smaller / reset text |

The toolbar's split button shows two chats side by side (a sidebar click fills
the side you're in); the sidebar collapses to a rail of chat bubbles. Links in
the terminal are clickable, and files dropped on it are attached to the chat.

**On a phone** (the web client), type in the message box at the bottom —
autocorrect and dictation work — and use the key bar for Esc, ⇧Tab, arrows,
Enter and Ctrl+C. "Add to Home Screen" opens it full-screen like an app.

## Status page

`status-page/` is published to GitHub Pages
(<https://jspinolawh.github.io/wh-dev-hub/>): whether the hub is up, 90 days
of uptime with every restart and outage, component checks, server info (the
build it runs vs `main`, Claude Code version, CPU / memory / disk, chats
running, people online) and the status of Claude Code, GitHub, Slack and
Tailscale. It opens from anywhere, Tailscale or not.

Pages can't reach the office PC, so the daemon reports out: every 2 minutes it
replaces the repo's `status` branch with one fresh commit holding
`status.json`, and the page reads that. When the heartbeats stop, the page
calls the hub offline. The page is public, so the heartbeat carries health,
counts and host stats only, never user names, chat names, paths or spend.

```jsonc
"statusPage": {
  "repo": "jspinolaWH/wh-dev-hub",  // where the status branch lives (the page reads it there)
  "token": "github_pat_…",          // fine-grained, this repo only, Contents: read & write
                                    //   (else GITHUB_TOKEN / GH_TOKEN, else the host's `gh` login)
  "intervalSec": 120,               // optional
  "checks": [                       // optional: more things on the PC to watch
    { "name": "Postgres (golden DB)", "tcp": "127.0.0.1:5432" },
    { "name": "Some service", "http": "http://127.0.0.1:3000/health" }
  ]
}
```

Without `statusPage` the daemon publishes nothing. To work on the page, serve
`status-page/` with any static server and open it with `?demo` (bundled
sample data) or `?repo=owner/name` (a real heartbeat).

## Tests

```
node daemon/test/smoke.mjs      # session keeps running with no client attached
node daemon/test/claude-e2e.mjs # real `claude -p` run inside a session
node daemon/test/multiuser.mjs  # read-only peek, owner-only input, isolated profiles
node daemon/test/preset.mjs     # port allocation + ${} substitution + live service
node daemon/test/history.mjs    # reopening a chat restores its whole scrollback
node daemon/test/rename.mjs     # `/rename` inside Claude renames the hub chat
node daemon/test/folders.mjs    # folders + colour tags: per-user, validated, persisted
node daemon/test/prs.mjs        # PR links collected per chat + GitHub/Linear status (own daemons, mocked APIs)
node daemon/test/activity.mjs   # live status: working -> idle -> needs you; title BELs ignored; coalesced
node daemon/test/views.mjs      # one chat in two views: closing one doesn't cut the other off
node daemon/test/status.mjs     # status page feed: orphan-commit heartbeat, nothing private, uptime across restarts (own daemons, mocked GitHub)
```

(Daemon must be running; tests read the token from `daemon/data/config.json`.)

## Roadmap

- Slack sign-in (OIDC, workspace-gated) issuing tokens
- Notifications (loop finished / permission prompt waiting) via Claude Code hooks
- WasteHero branding, `Setup.exe` for clients, daemon as a Windows service
- Session auto-resume after daemon restart (`claude --resume`)
