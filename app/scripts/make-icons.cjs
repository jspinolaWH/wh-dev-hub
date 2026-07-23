// Renders the blue WH mark SVG into icon.png (256/512) and icon.ico for
// the window, taskbar, and installer.
const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')
const pngToIcoModule = require('png-to-ico')
const pngToIco = pngToIcoModule.default ?? pngToIcoModule

const svgPath = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'wh-mark.svg')
const outDir = path.join(__dirname, '..', 'build')

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  const svg = fs.readFileSync(svgPath)

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = []
  for (const size of sizes) {
    const buf = await sharp(svg, { density: 300 }).resize(size, size).png().toBuffer()
    pngs.push(buf)
    if (size === 256) fs.writeFileSync(path.join(outDir, 'icon.png'), buf)
  }
  const bigBuf = await sharp(svg, { density: 300 }).resize(512, 512).png().toBuffer()
  fs.writeFileSync(path.join(outDir, 'icon-512.png'), bigBuf)

  const ico = await pngToIco(pngs)
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico)
  console.log('icons written to', outDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
