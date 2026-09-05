#!/usr/bin/env node
/**
 * Renders PNG icons from the SVG masters in public/icons/.
 * Run from repo root: node apps/web/scripts/render-icons.mjs
 *
 * Regenerate whenever source.svg / source-maskable.svg changes.
 */
import sharp from 'sharp'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const iconsDir = resolve(here, '..', 'public', 'icons')

const svgBase = await readFile(resolve(iconsDir, 'source.svg'))
const svgMaskable = await readFile(resolve(iconsDir, 'source-maskable.svg'))

const targets = [
  { svg: svgBase,    size: 192, out: '192.png' },
  { svg: svgBase,    size: 512, out: '512.png' },
  { svg: svgBase,    size: 180, out: 'apple-touch-icon.png' },
  { svg: svgBase,    size: 32,  out: 'favicon-32.png' },
  { svg: svgBase,    size: 16,  out: 'favicon-16.png' },
  { svg: svgMaskable, size: 192, out: 'maskable-192.png' },
  { svg: svgMaskable, size: 512, out: 'maskable-512.png' },
]

for (const { svg, size, out } of targets) {
  const buf = await sharp(svg, { density: 300 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer()
  await writeFile(resolve(iconsDir, out), buf)
  console.log(`✓ ${out} (${size}×${size}, ${buf.length}B)`)
}

console.log('\nDone. Update manifest.ts / layout.tsx references if new files were added.')
