// Emits Claude-Code-like output for history.mjs: real history lines, then a
// long burst of in-place spinner redraws (cursor-up + erase + per-character
// truecolor "shimmer") that adds lots of bytes but no new history.
const out = (s) => new Promise((r) => process.stdout.write(s, r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const frames = Number(process.argv[2] ?? 900)

for (let i = 1; i <= 300; i++) {
  await out(`\x1b[38;2;117;189;234m●\x1b[0m HIST_LINE_${String(i).padStart(4, '0')} some tool output\r\n`)
}
const word = 'Infusing… (esc to interrupt · ctrl+t to show todos)'
await out('\r\n\r\n\r\n')
for (let f = 0; f < frames; f++) {
  let line = ''
  for (let c = 0; c < word.length; c++) line += `\x1b[38;2;215;${100 + ((c * 7 + f * 13) % 150)};112m${word[c]}`
  await out(`\x1b[3A\r\x1b[2K${line}\x1b[0m\r\n\x1b[2K> frame ${f}\r\n\x1b[2K  ? for shortcuts\r\n`)
  await sleep(4)
}
await out('HIST_DONE\r\n')
setInterval(() => {}, 1000) // stay alive like an interactive session
