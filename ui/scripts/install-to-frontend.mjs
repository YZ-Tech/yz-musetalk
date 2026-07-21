#!/usr/bin/env node
// CANONICAL ui-tooling — DO NOT EDIT the per-satellite copies.
// Source of truth: satellites/_ui-tooling/install-to-frontend.mjs.
// Stamp changes into every ui/scripts/ with `node satellites/_ui-tooling/sync.mjs`;
// installer/build-index.ps1 FAILS on drift between a copy and this file.
//
// Ships the built IIFE + the satellite's manifest.json to BOTH:
//   - frontend/public/modules/             (Vite source-of-truth for public assets)
//   - backend/jarvyz/web/static/modules/   (JarvYZ production-serve dir)
//
// Why both: JarvYZ serves backend/jarvyz/web/static/ directly; the frontend's
// Vite build copies public/ -> static/ as part of its pipeline. During dev
// iteration on a module we don't want to require a full frontend rebuild just
// to deploy a new IIFE, so `npm run ship` lands it in both.
//
// Everything satellite-specific is DERIVED: the slug comes from the satellite's
// manifest.json `id` (the drift that used to live in 11 hand-edited copies —
// incl. the 2026-07-04 stale-manifest bug — can't happen). Extra per-satellite
// ship steps (e.g. yz-iris's MediaPipe assets) live in an optional sibling
// `ship.extra.mjs` (default export: async ({ slug, uiRoot, satelliteRoot,
// modulesDirs }) => {}).
//
// Standalone split repos: the monorepo targets don't exist there — this script
// then no-ops with a note (their CI builds the IIFE via build:lib directly).
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Layout: satellites/yz-<id>/ui/scripts/ -> climb 4 levels to the monorepo root
const projectRoot = resolve(here, '..', '..', '..', '..')
const satelliteRoot = resolve(here, '..', '..')
const uiRoot = resolve(here, '..')

// -- Identity from the manifest (single source) ----------------------------
const manifestSrc = resolve(satelliteRoot, 'manifest.json')
if (!existsSync(manifestSrc)) {
  console.error(`[error] ${manifestSrc} not found — a satellite must have a manifest to ship.`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestSrc, 'utf8'))
if (!manifest.id) {
  console.error(`[error] ${manifestSrc} has no \`id\` field.`)
  process.exit(1)
}
const slug = `yz-${manifest.id}`

const iifeSrc = resolve(uiRoot, 'dist-lib', `${slug}.iife.js`)

// -- Monorepo targets (absent in a standalone split repo -> graceful no-op) -
const targetRoots = [
  resolve(projectRoot, 'frontend', 'public', 'modules'),
  resolve(projectRoot, 'backend', 'jarvyz', 'web', 'static', 'modules'),
].filter((d) => existsSync(resolve(d, '..')))
if (targetRoots.length === 0) {
  console.log(`[note] no monorepo targets found from ${projectRoot} — standalone repo, nothing to ship.`)
  process.exit(0)
}

// -- Sanity: IIFE exists ----------------------------------------------------
try {
  statSync(iifeSrc)
} catch {
  console.error(`[error] ${iifeSrc} not found. Run \`npm run build:lib\` first.`)
  process.exit(1)
}

// -- Drift check: manifest claims should resolve in the IIFE ----------------
{
  const iifeBody = readFileSync(iifeSrc, 'utf8')
  const claimed = new Set()
  for (const d of manifest.dashboards || []) claimed.add(d.component)
  for (const e of manifest.exports || []) claimed.add(e.id)
  const missing = []
  for (const name of claimed) {
    const re = new RegExp(`\\b${name}\\b`)
    if (!re.test(iifeBody)) missing.push(name)
  }
  if (missing.length) {
    console.error(
      `[error] manifest claims exports the IIFE doesn't appear to provide:\n  ${missing.join('\n  ')}\n` +
      `Check satellites/${slug}/ui/src/index.ts.`,
    )
    process.exit(1)
  }
  console.log(`[ok] manifest drift check passed (${claimed.size} exports validated)`)
}

// -- Copy IIFE + manifest ----------------------------------------------------
console.log(`[ok] ${iifeSrc}`)
for (const rootDir of targetRoots) {
  mkdirSync(rootDir, { recursive: true })
  const iifeDst = resolve(rootDir, `${slug}.iife.js`)
  copyFileSync(iifeSrc, iifeDst)
  console.log(`  -> ${iifeDst}`)
  console.log(`     ${(statSync(iifeDst).size / 1024).toFixed(1)} KB`)
}
console.log(`[ok] ${manifestSrc}`)
for (const rootDir of targetRoots) {
  copyFileSync(manifestSrc, resolve(rootDir, `${slug}.manifest.json`))
  console.log(`  -> ${resolve(rootDir, `${slug}.manifest.json`)}`)
}

// -- Optional per-satellite extra steps --------------------------------------
const extra = resolve(here, 'ship.extra.mjs')
if (existsSync(extra)) {
  const mod = await import(pathToFileURL(extra).href)
  await mod.default({ slug, uiRoot, satelliteRoot, modulesDirs: targetRoots })
}
