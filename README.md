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
  "scrollbackChars": 2000000
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

## Tests

```
node daemon/test/smoke.mjs      # session keeps running with no client attached
node daemon/test/claude-e2e.mjs # real `claude -p` run inside a session
node daemon/test/multiuser.mjs  # read-only peek, owner-only input, isolated profiles
node daemon/test/preset.mjs     # port allocation + ${} substitution + live service
```

(Daemon must be running; tests read the token from `daemon/data/config.json`.)

## Roadmap

- Slack sign-in (OIDC, workspace-gated) issuing tokens
- Notifications (loop finished / permission prompt waiting) via Claude Code hooks
- WasteHero branding, `Setup.exe` for clients, daemon as a Windows service
- Session auto-resume after daemon restart (`claude --resume`)
