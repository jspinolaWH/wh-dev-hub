// Removes the WasteHero Dev Hub Windows service.
const path = require('node:path')
const { Service } = require('node-windows')

const repoRoot = path.resolve(__dirname, '..', '..')
const svc = new Service({
  name: 'WasteHero Dev Hub',
  script: path.join(repoRoot, 'daemon', 'dist', 'index.cjs'),
})
svc.on('uninstall', () => console.log('service uninstalled.'))
svc.on('error', (err) => console.error('service error:', err))
svc.uninstall()
