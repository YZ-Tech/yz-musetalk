// CANONICAL ui-tooling — DO NOT EDIT the per-satellite copies.
// Source of truth: satellites/_ui-tooling/vite-lib.mjs. Stamp with
// `node satellites/_ui-tooling/sync.mjs`; build-index.ps1 fails on drift.
//
// The shared IIFE build recipe every satellite vite.config.ts used to
// hand-copy. Mode 'lib': a dynamic module loaded by JarvYZ via
// @yz-dev/react-dynamic-module.
//   - Externalises react/react-dom (the host injects them via window globals).
//   - Bundles MUI/emotion (theme propagates via the ledfx theme-prop pattern).
//   - CJS require shim banner: zustand v5 transitively pulls
//     `use-sync-external-store/shim/with-selector`, which does a literal
//     `require("react")` inside the IIFE — the banner routes it to the
//     window globals. Kept for EVERY satellite so the recipe stays uniform.
//
// Identity is DERIVED from the satellite's manifest.json (`id`):
// slug `yz-<id>`, IIFE global `Yz<PascalCase(id)>` — the convention every
// satellite already followed by hand.
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

/** Build the vite `lib` UserConfig for a satellite ui.
 *  @param metaUrl pass `import.meta.url` from the satellite's vite.config.ts
 *  @param react   pass the `@vitejs/plugin-react` factory (peer of the ui) */
export function makeLibConfig(metaUrl, react) {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../manifest.json', metaUrl)), 'utf8'),
  )
  const slug = `yz-${manifest.id}`
  const globalName =
    'Yz' + manifest.id.split(/[-_]/).map((p) => p[0].toUpperCase() + p.slice(1)).join('')

  return {
    plugins: [react()],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      outDir: 'dist-lib',
      emptyOutDir: true,
      lib: {
        entry: fileURLToPath(new URL('./src/index.ts', metaUrl)),
        name: globalName,
        formats: ['iife'],
        fileName: () => `${slug}.iife.js`,
      },
      rollupOptions: {
        external: ['react', 'react-dom'],
        output: {
          globals: { react: 'React', 'react-dom': 'ReactDOM' },
          exports: 'named',
          extend: true,
          banner:
            'var require = function(id) {' +
            ' if (id === "react") return window.React;' +
            ' if (id === "react-dom") return window.ReactDOM;' +
            ' throw new Error("require not handled: " + id);' +
            ' };',
        },
      },
    },
  }
}
