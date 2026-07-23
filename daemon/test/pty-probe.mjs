import * as pty from '@lydell/node-pty'

const CMD = 'powershell -NoProfile -Command "1..3 | ForEach-Object { Write-Host tick-$_ }"'

function probe(label, file, args) {
  return new Promise((resolve) => {
    let out = ''
    let p
    try {
      p = pty.spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
    } catch (e) {
      return resolve(`${label}: SPAWN ERROR ${e.message}`)
    }
    p.onData((d) => (out += d))
    p.onExit(({ exitCode }) => resolve(`${label}: exit=${exitCode} ticks=${(out.match(/tick-\d/g) || []).join(',')} rawLen=${out.length}`))
    setTimeout(() => { try { p.kill() } catch {} }, 8000)
  })
}

console.log(await probe('A array-args', process.env.ComSpec, ['/d', '/s', '/c', CMD]))
console.log(await probe('B string-args', process.env.ComSpec, `/d /s /c "${CMD}"`))
console.log(await probe('C direct-pwsh array', 'powershell.exe', ['-NoProfile', '-Command', '1..3 | ForEach-Object { Write-Host tick-$_ }']))
