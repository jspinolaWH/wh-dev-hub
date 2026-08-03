# WasteHero Dev Hub — onboarding a new person

How to connect a new teammate, on a new machine (Mac or Windows), to the
office Dev Hub server. The web client needs **no install** beyond Tailscale —
you just open a URL in a browser. Each person uses **their own** Tailscale,
Slack, and Claude accounts; everyone sees only their own sessions.

Server address (office PC, over Tailscale):
- `http://100.64.128.82:7811`  (Tailscale IP)
- `http://jack.tailc248d9.ts.net:7811`  (Tailscale hostname / MagicDNS)

---

## Part A — What the owner does, once per person

1. **Add them to the WasteHero Slack workspace** (if not already a member).
   The hub sign-in only admits WasteHero Slack accounts.

2. **Invite them to the Tailscale network:**
   - Go to https://login.tailscale.com
   - Sidebar → **Users** → **Invite external users**
   - Enter their **email** → **Send invite**
   - (Free plan = 6 users.)

3. **Tell them they need their own Claude account** (Pro / Max / Enterprise).
   Their agents run on their login and their bill.

That's all on the owner's side.

---

## Part B — What the new person does on their machine

### 1. Join the Tailscale network
1. Open the **invite email** and click the link.
2. **Sign in with your OWN account** (Google / GitHub / Microsoft / email) —
   NOT the owner's. This joins you to the WasteHero tailnet.
3. Install the Tailscale app:
   - **Mac:** Mac App Store → **Tailscale** (or choose **macOS** on the
     "add device" screen).
   - **Windows:** https://tailscale.com/download
4. Open Tailscale, sign in with the **same** account, and make sure it is
   **connected / on** (check the menu-bar icon on Mac, tray icon on Windows).

### 2. Open the hub
5. Open **Safari or Chrome**.
6. Go to **http://100.64.128.82:7811**
   (if it doesn't load, try **http://jack.tailc248d9.ts.net:7811**).
7. You should see the **WasteHero Dev Hub** page with a **Sign in with Slack**
   button. Optionally add it to your Home Screen / bookmarks.

### 3. Sign in
8. Click **Sign in with Slack** → approve in Slack (your WasteHero account).
9. You will hit a **"Your connection is not private"** warning — this is
   expected (the login callback uses a self-signed certificate on the private
   network). Proceed:
   - **Safari:** Show Details → visit this website → Visit Website
   - **Chrome:** Advanced → Proceed to jack.tailc248d9.ts.net (unsafe)
10. You'll see a **"Signed in as …"** page and the hub connects itself. You now
    see **your own** (empty) session list — never anyone else's.

### 4. First Claude login (one time)
11. Click **+ New session**. Keep the default working directory, set
    **Start with: Shell**, then **Create**.
12. In the terminal type `claude` and press Enter.
13. Claude prompts you to log in — sign into **your own Claude account**. This
    is saved to your private profile on the server; you only do it once.
14. Done. Your sessions, login, and usage are all yours from here.

---

## Troubleshooting

- **Page won't load / "site can't be reached":** Tailscale isn't connected.
  Open the Tailscale app, confirm it's on, retry. Try the IP if the hostname
  fails.
- **"could not reach daemon" in the app:** same fix — Tailscale must be on.
- **Certificate warning at the Slack step:** expected; click through. Appears
  once per browser.
- **Slack sign-in hangs / callback won't open:** MagicDNS may not be resolving
  the callback host on your machine. Ask the owner — there's a token fallback
  ("Connect with a token instead") and the owner can issue you a token.
- **You can see the owner's chats:** the office daemon hasn't been updated with
  the per-user isolation fix yet — the owner needs to redeploy, then refresh.

---

## Notes

- **Nothing to install but Tailscale** — the hub UI is served by the server and
  runs in your browser. No repo, no git, no build on your side.
- **Sessions live on the office PC**, not your machine — close the browser or
  shut your laptop and your loops keep running; reopen anytime to reattach.
- **Windows users** can optionally use the native desktop app instead of the
  browser (installer: `WasteHero Dev Hub Setup <version>.exe`), but the browser
  works identically.
- Three separate logins, each your own: **Tailscale** (network) →
  **Slack** (hub access) → **Claude** (inside your first session).
