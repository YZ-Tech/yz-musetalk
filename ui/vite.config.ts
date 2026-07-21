import { defineConfig, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { makeLibConfig } from './scripts/vite-lib.mjs'

// Mode 'lib': IIFE module loaded by JarvYZ via @yz-dev/react-dynamic-module.
//   - Externalises react/react-dom (host injects via window globals).
//   - Bundles MUI/emotion (theme propagates via theme-prop pattern;
//     see SATELLITE_DYNAMIC_MODULES.md).
//
// Mode 'pages' (default): standalone SPA. Built into
// ../wrapper/static/ so the wrapper container's StaticFiles mount
// at / serves the UI. A friend running `cd satellites/yz-musetalk &&
// docker compose up` gets a working UI at http://127.0.0.1:8901/.

// The IIFE lib recipe is the CANONICAL shared one (slug + global name
// derived from ../manifest.json) — see satellites/_ui-tooling/README.md.
const libConfig: UserConfig = makeLibConfig(import.meta.url, react)

// Wrapper container exposes refs CRUD + /ws/say at this URL.
const SAT = process.env.VITE_SATELLITE_URL || 'http://127.0.0.1:8901'

const pagesConfig: UserConfig = {
  plugins: [react()],
  server: {
    port: 5190,
    host: '127.0.0.1',
    proxy: {
      '/health': SAT,
      '/refs': SAT,
      '/set_active': SAT,
      '/ws/say': { target: SAT, ws: true },
    },
  },
  build: {
    // Standalone SPA goes into the wrapper's static dir. The wrapper's
    // FastAPI StaticFiles mount serves them at /. This means the
    // wrapper container ships the SPA bundled.
    outDir: fileURLToPath(new URL('../wrapper/static', import.meta.url)),
    emptyOutDir: true,
  },
}

export default defineConfig(({ mode }) => (mode === 'lib' ? libConfig : pagesConfig))
