// Prints Claude Code's `/rename` confirmations (as rendered) for rename.mjs,
// with a look-alike in between that must NOT rename the chat.
const out = (s) => new Promise((r) => process.stdout.write(s, r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Like Claude's TUI, each confirmation is part of one in-place repaint: the
// line itself, then the prompt box with its full-width rules redrawn below it
// (so the confirmation is NOT the end of the output chunk).
const rule = `\x1b[38;2;136;136;136m${'─'.repeat(118)}\x1b[39m\x1b[K`
const promptBox = `\r\n${rule}\r\n❯ \x1b[K\r\n${rule}\r\n  ? for shortcuts\x1b[K`
const repaint = (row, lines) => out(`\x1b[${row};1H${lines.map((l) => `${l}\x1b[K`).join('\r\n')}${promptBox}`)

await out('\x1b[2J\x1b[HWelcome to the fake Claude\r\n')
await repaint(4, [''])
await sleep(1500)
await repaint(4, ['\x1b[38;2;153;153;153m❯\x1b[m /rename Pricing API spike', '  \x1b[2m⎿  \x1b[mSession renamed to: Pricing API spike', ''])
await sleep(2500)
// Not a confirmation: an assistant message quoting the phrase.
await repaint(7, ['\x1b[38;2;255;255;255m●\x1b[m The hub shows "Session renamed to: fake" after that.', ''])
await sleep(2500)
// The name was held by another live session, so Claude picked another one.
await repaint(9, ['  ⎿  Session renamed to: checkout-2 ("checkout" is held by another live session on this machine)', ''])
setInterval(() => {}, 1000) // stay alive like an interactive session
