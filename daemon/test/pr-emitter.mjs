// Prints PR links the way a Claude chat would, for prs.mjs: mixed casing, a
// duplicate, a "create PR" link (not a PR), and a PR we can't see on GitHub —
// printed again later, after the test has removed it from the list.
const out = (s) => new Promise((r) => process.stdout.write(s, r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await sleep(800)
await out('\x1b[38;2;153;153;153m  ⎿  \x1b[mhttps://github.com/wastehero/wastehero_frontend/pull/1099\r\n')
await out('\x1b[1m●\x1b[22m Opened https://github.com/WasteHero/wastehero_backend_v1/pull/2132 for the zone fix.\r\n')
await out('Same one: https://github.com/WasteHero/wastehero_frontend/pull/1099 and https://github.com/WasteHero/wastehero_frontend/pull/new/fix-x\r\n')
await out('Mentioned: https://github.com/other/private/pull/7\r\n')
await sleep(5000)
await out('Mentioned again: https://github.com/other/private/pull/7\r\n')
setInterval(() => {}, 1000) // stay alive like an interactive session
