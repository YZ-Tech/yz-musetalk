// Standalone SPA entry. Served by the wrapper container at
// http://127.0.0.1:8901/. Friend can `docker compose up` + browse here
// to manage refs without needing JarvYZ. Synthesis-driven face
// animation requires sending audio to /ws/say, which is Phase 7 work
// (AudioDropZone) — for now the standalone UI is refs-management +
// the V12 backdrop.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import { V12Dashboard } from './V12Dashboard'
import { createSatelliteApi } from './lib/api'
import type { Capabilities } from './lib/capabilities'

const api = createSatelliteApi({ apiBase: '' })

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#7c4dff' },  // distinct purple; people satellite shares it
    background: { default: '#0d0d12', paper: '#15151c' },
  },
})

const capabilities: Capabilities = {
  apiBase: '',
  deployTarget: 'standalone',
  // Wrapper container has no TTS engine; text → frames needs JarvYZ.
  // TextInputCard hides itself when canSynthesize is false.
  canSynthesize: false,
}


function StandaloneHeader() {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 16,
        paddingBottom: 12,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <img src="/logo.svg" alt="" width={32} height={32} style={{ display: 'block' }} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <strong style={{ fontSize: '1.05rem', letterSpacing: '0.02em' }}>
          MuseTalk
        </strong>
        <span style={{ fontSize: '0.75rem', opacity: 0.55 }}>satellite · standalone</span>
      </div>
    </header>
  )
}


function StandaloneRoot() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <div style={{ padding: 16, maxWidth: 1400, margin: '0 auto' }}>
        <StandaloneHeader />
        <V12Dashboard theme={theme} api={api} capabilities={capabilities} />
      </div>
    </ThemeProvider>
  )
}


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StandaloneRoot />
  </StrictMode>,
)
