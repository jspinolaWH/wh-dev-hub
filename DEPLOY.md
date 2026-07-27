# Deploying WasteHero Dev Hub

Two pieces: the **daemon** on the always-on office PC (the session host), and
the **client installer** for every teammate's machine.

## 0. Network (once)

Install [Tailscale](https://tailscale.com/download) on the office PC and on
every teammate's machine, all logged into the same tailnet (free plan covers
6 users). Note the office PC's Tailscale hostname/IP (`tailscale status`),
e.g. `office-pc.tailnet-name.ts.net` or `100.x.y.z`.

## 1. Office PC — daemon

```powershell
# Prereqs: Node 22+, git. Claude Code CLI installed and on PATH.
git clone <this repo> C:\wh-dev-hub
cd C:\wh-dev-hub
powershell -ExecutionPolicy Bypass -File deploy\install-daemon.ps1
```

The installer builds the daemon, registers an auto-starting logon task with a
crash-restart loop, and starts it. Data lives in `%USERPROFILE%\.wh-dev-hub`.

### Recommended on a shared PC: run as a Windows service

The logon-task install above works, but its hidden console can be Ctrl-C'd by
anyone using the machine (this happened — the daemon was down a whole weekend).
For an always-on host, install it as a real service instead:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\install-service.ps1
```

Run elevated. It builds the daemon, removes the logon task, and installs a
service that runs as **your user account** (so the Claude CLI, its login
profile, and PATH match), with **no console to Ctrl-C**, that **survives
logoff/reboot** and **auto-restarts on crash**. You are prompted once for your
Windows password (required to run a service as a user rather than LocalSystem).
Uninstall: `node deploy\service\uninstall-service.js` (elevated).

### Config

Then edit `%USERPROFILE%\.wh-dev-hub\config.json`:

| key | value |
|-----|-------|
| `host` | `0.0.0.0` (or the Tailscale IP to bind only there) |
| `slack.publicHost` | the office PC's Tailscale hostname |
| `slack.clientId/clientSecret` | copy from the dev machine's config (same Slack app) |
| `presets` | see README — add the WasteHero stack preset |

Restart the daemon after config changes:
`schtasks /End /TN "WasteHero Dev Hub Daemon" & schtasks /Run /TN "WasteHero Dev Hub Daemon"`.

**Slack redirect URL**: add
`https://<tailscale-host>:7812/auth/slack/callback` to the Slack app
(api.slack.com/apps → WasteHero Dev Hub → OAuth & Permissions), keeping the
existing 127.0.0.1 one for local dev.

**Firewall**: allow inbound TCP 7811 (WS) and 7812 (sign-in callback) — scope
the rule to the Tailscale interface/subnet (100.64.0.0/10):

```powershell
New-NetFirewallRule -DisplayName "WH Dev Hub" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 7811,7812 -RemoteAddress 100.64.0.0/10
```

**Power**: keep the machine awake —

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

**Claude logins**: each teammate's first session opens Claude's login inside
the terminal — one time per person (their profile lives in
`.wh-dev-hub\profiles\<user>\claude`). Users listed in
`inheritHostClaudeLogin` reuse the office PC's own `claude` login instead.

## 2. Teammate machines — client

Build the installer (on any machine with the repo):

```
npm run dist -w app
# → %LOCALAPPDATA%\wh-hub-release\WasteHero Dev Hub Setup <version>.exe
```

Send teammates the `Setup.exe`. They install, enter the daemon address
`ws://<tailscale-host>:7811`, click **Sign in with Slack**, done.

> Build note: electron-builder output must NOT live under Desktop — AV/indexer
> file locks break its rename step. The npm scripts already point output at
> `%LOCALAPPDATA%\wh-hub-release`.

## 3. Sanity checklist after deploy

- [ ] `tailscale ping <office-pc>` works from a teammate laptop
- [ ] App connects via Slack sign-in from outside the office network
- [ ] Create a session, run a long task, close the app, reattach — it continued
- [ ] Reboot the office PC — daemon comes back by itself (logon task)
- [ ] Firewall blocks 7811/7812 from non-Tailscale addresses

## Known limitations (v1)

- Sessions do not survive a daemon restart/reboot (they reappear as `lost`;
  `claude --resume` auto-revive is on the roadmap). Restart the daemon only
  when nobody has a loop running.
- The sign-in callback uses a self-signed cert — browsers warn once per
  machine. Tailscale `tailscale cert` can replace it later.
- Slack tokens never expire in v1 — remove entries from `tokens` in
  config.json to revoke someone.
