// Bundles the daemon into dist/index.cjs, stamped with the commit it was built
// from, so the status page can tell whether the office PC runs the latest code
// (the bundle, not whatever is checked out next to it).
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'

let stamp = {}
try {
  const [sha, date, subject] = execFileSync('git', ['log', '-1', '--format=%H%n%cI%n%s'], { encoding: 'utf8' }).trim().split('\n')
  stamp = { sha, date, subject }
} catch {
  console.warn('[build] not a git checkout: the bundle carries no commit')
}

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  outfile: 'dist/index.cjs',
  external: ['@lydell/node-pty'],
  define: { 'process.env.WH_BUILD': JSON.stringify(JSON.stringify(stamp)) },
  logLevel: 'info',
})
