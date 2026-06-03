#!/usr/bin/env node
// Copy the built IIFE + manifest to BOTH:
//   - frontend/public/modules/  (Vite source-of-truth for public assets)
//   - backend/jarvyz/web/static/modules/       (Jarvis production-serve dir)
//
// Plus the manifest.json from the satellite root → both targets, so
// the frontend registry can fetch it at /modules/yz-musetalk.manifest.json
// and the Python pipeline.satellite_manifest reader picks it up too.
//
// Build-time drift check: assert the IIFE actually exports the names
// the manifest claims. See DYNAMIC_MODULES.md "Drift validation".
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Layout: satellites/musetalk/ui/scripts/ → climb 4 levels to project root
const projectRoot = resolve(here, '..', '..', '..', '..')
const satelliteRoot = resolve(here, '..', '..')

const iifeSrc = resolve(here, '..', 'dist-lib', 'yz-musetalk.iife.js')
const manifestSrc = resolve(satelliteRoot, 'manifest.json')

const iifeTargets = [
  resolve(projectRoot, 'frontend', 'public', 'modules', 'yz-musetalk.iife.js'),
  resolve(projectRoot, 'backend', 'jarvyz', 'web', 'static', 'modules', 'yz-musetalk.iife.js'),
]
const manifestTargets = [
  resolve(projectRoot, 'frontend', 'public', 'modules', 'yz-musetalk.manifest.json'),
  resolve(projectRoot, 'backend', 'jarvyz', 'web', 'static', 'modules', 'yz-musetalk.manifest.json'),
]

// ── Sanity: IIFE exists ───────────────────────────────────────────
try {
  statSync(iifeSrc)
} catch {
  console.error(`✗ ${iifeSrc} not found. Run \`npm run build:lib\` first.`)
  process.exit(1)
}

// ── Drift check: manifest claims should resolve in the IIFE ───────
// Static-string check: search the IIFE source for `var X` patterns
// matching each claimed export name. Loose but catches the obvious
// "renamed an export, forgot to update manifest" case. Runtime warn
// (in the frontend registry) catches anything this misses.
if (existsSync(manifestSrc)) {
  const manifest = JSON.parse(readFileSync(manifestSrc, 'utf8'))
  const iifeBody = readFileSync(iifeSrc, 'utf8')
  const claimed = new Set()
  for (const d of manifest.dashboards || []) claimed.add(d.component)
  for (const e of manifest.exports || []) claimed.add(e.id)
  const missing = []
  for (const name of claimed) {
    // IIFE's `extend: true, exports: 'named'` rollup output names them
    // via `var <name>` at top level, then attaches to window.YzMusetalk.
    // Searching for `\b<name>\b` is a coarse but reliable proxy.
    const re = new RegExp(`\\b${name}\\b`)
    if (!re.test(iifeBody)) missing.push(name)
  }
  if (missing.length) {
    console.error(
      `✗ manifest claims exports the IIFE doesn't appear to provide:\n  ${missing.join('\n  ')}\n` +
      `Check satellites/musetalk/ui/src/index.ts.`,
    )
    process.exit(1)
  }
  console.log(`✓ manifest drift check passed (${claimed.size} exports validated)`)
} else {
  console.warn(`⚠ ${manifestSrc} not found — skipping drift check`)
}

// ── Copy IIFE ─────────────────────────────────────────────────────
console.log(`✓ ${iifeSrc}`)
for (const dst of iifeTargets) {
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(iifeSrc, dst)
  const { size } = statSync(dst)
  console.log(`  → ${dst}`)
  console.log(`    ${(size / 1024).toFixed(1)} KB`)
}

// ── Copy manifest.json ───────────────────────────────────────────
if (existsSync(manifestSrc)) {
  console.log(`✓ ${manifestSrc}`)
  for (const dst of manifestTargets) {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(manifestSrc, dst)
    console.log(`  → ${dst}`)
  }
}
