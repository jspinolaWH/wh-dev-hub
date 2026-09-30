// A fake Claude chat for activity.mjs: works for ~3s (an action line, spinner
// frames, and title updates whose BEL must NOT count as "needs you"), goes
// quiet, then shows a permission prompt and waits.
const out = (s) => new Promise((r) => process.stdout.write(s, r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await sleep(500)
await out('\x1b[38;2;117;189;234m●\x1b[0m Reading the config\r\n\r\n\r\n')
for (let f = 0; f < 30; f++) {
  await out(`\x1b]0;${'◐◓◑◒'[f % 4]} Claude Code\x07\x1b[2A\r\x1b[2K✻ Herding… (${f}s)\r\n\x1b[2K? for shortcuts\r\n`)
  await sleep(100)
}
await sleep(13_000) // quiet: working -> idle
await out('\r\n\x1b[38;2;117;189;234m●\x1b[0m Bash(npm test)\r\n')
await out('  Do you want to proceed?\r\n  \x1b[36m❯\x1b[0m 1. Yes\r\n    2. Yes, and don’t ask again for npm test\r\n    3. No, and tell Claude what to do differently (esc)\r\n')
setInterval(() => {}, 1000) // stay alive like an interactive session
