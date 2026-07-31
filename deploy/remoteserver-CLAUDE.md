# RemoteServer — remote session host (READ THIS FIRST)

You are running on the WasteHero **Dev Hub host PC**, inside `RemoteServer`.
Sessions here are driven remotely (from a laptop/phone over Tailscale) — the
person using you is **not** sitting at this machine. This changes one thing
fundamentally and it is easy to get wrong:

> **`localhost` / `127.0.0.1` on this machine is NOT the user's machine.**
> Anything you bind to localhost is invisible to them.

Follow these standing rules for every server, app, or service you start here.

## 1. Bind every server to `0.0.0.0`, never localhost

Use the injected env var `WH_BIND_HOST` (= `0.0.0.0`). Examples:

- Django: `python manage.py runserver 0.0.0.0:8000`
- Daphne/uvicorn: `-b 0.0.0.0` / `--host 0.0.0.0`
- Vite: `--host 0.0.0.0` (or `server.host: true` in vite config)
- Next.js: `next dev -H 0.0.0.0`
- Docker: `-p <port>:<port>` already binds `0.0.0.0` — nothing extra needed.

If a dev server has no host flag, set `HOST=0.0.0.0` in its env before starting.

## 2. Point frontends at the tailnet host, never localhost

A frontend's API / GraphQL / WebSocket base URL runs in the **user's browser**,
so `localhost` there means *their* machine and will fail. Use the injected
env var `WH_TAILNET_HOST` (this machine's Tailscale name).

- Set the FE's API base (e.g. `.env.local`, `VITE_*`/`REACT_APP_*` vars) to
  `http://${WH_TAILNET_HOST}:<backend-port>` — not `http://localhost:...`.
- Do the same for websocket URLs (`ws://${WH_TAILNET_HOST}:<port>`).

## 2b. Add the tailnet host to framework host-allowlists

Modern dev servers reject requests whose `Host` header they don't recognize.
When serving over the tailnet you MUST allowlist `WH_TAILNET_HOST` (a private
tailnet, so wildcards are fine here):

- **Vite:** `server.allowedHosts: ['.ts.net']` (or `true`) in the vite config,
  or start with `--host` is NOT enough — the allowlist is separate. Symptom:
  "Blocked request. This host (...) is not allowed."
- **Django:** `ALLOWED_HOSTS` must include the tailnet host (or `['*']` for a
  local/dev tenant). Symptom: `DisallowedHost` / HTTP 400. If POSTs fail CSRF,
  also add `http://${WH_TAILNET_HOST}:<port>` to `CSRF_TRUSTED_ORIGINS`.
- **Next.js / others:** check for an equivalent allowed-hosts / origins option.

Prefer setting these via the dev `.env.local` / a dev settings override rather
than editing tracked config, but on a throwaway clone in RemoteServer editing
the config directly is fine (just don't commit it).

## 3. Use the reserved, already-open port ranges

These ranges are permanently allowed through this machine's firewall for the
Tailscale network only — use them and you never touch the firewall:

- **Frontends:** `3000–3099`
- **Backends / APIs:** `8000–8099`

If you genuinely need a port outside these, tell the user — they must add a
firewall rule for it.

## 4. Tell the user the exact reachable URL

After starting anything, give them the URL to open:
`http://${WH_TAILNET_HOST}:<port>` (e.g. `http://jack.tailc248d9.ts.net:3000`).

## 4b. Restarting the daemon after an update (no UAC)

If you pull new daemon code and rebuild it (`npm run build -w daemon`), restart
the service to load it — WITHOUT an elevation prompt — with:

```
schtasks /Run /TN "WH Restart Daemon"
```

This is a pre-elevated on-demand task (set up once by install-service.ps1 /
enable-remote-restart.ps1). Do NOT use `Restart-Service` directly — that
triggers a UAC dialog on this PC's secure desktop, which can't be approved
remotely. Restarting drops running sessions to "lost" (relaunchable), so only
do it when no one is mid-loop.

## 4c. Report progress for the overview (WH-PROGRESS)

You run as one of many parallel sessions the user watches from an Overview
dashboard. Help them see your status at a glance: **periodically print a
single progress line** (roughly whenever you finish a step or your estimate
changes) in exactly this format:

```
[[WH-PROGRESS pct=<0-100> eta=<e.g. 5m|1h|unknown> note="<short what you're doing>"]]
```

Example: `[[WH-PROGRESS pct=60 eta=4m note="wiring the price-determination API into the FE picker"]]`

Rules: keep `note` short (a few words), give an honest `pct` and `eta` (say
`eta=unknown` if you truly can't estimate — don't invent precision), and print
it on its own line so it's easy to parse. It costs nothing but a line of
output and lets the user triage many sessions without opening each one.

## 5. Housekeeping

- Keep all work **inside `RemoteServer`** — other people use this PC; don't
  touch their folders or run machine-wide docker/cleanup commands.
- Long build loops and "run the app" servers should be **separate sessions**,
  so a running server doesn't block a loop's terminal.
- Don't rebind anything to `127.0.0.1` "just to test" — it won't be reachable.

If `WH_TAILNET_HOST` / `WH_BIND_HOST` are unset, you're not running under the
Dev Hub daemon — ask the user for the machine's Tailscale hostname before
starting servers.
