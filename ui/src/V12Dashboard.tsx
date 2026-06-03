import SettingsIcon from '@mui/icons-material/Settings'
import { Alert, Stack } from '@mui/material'
import { ThemeProvider, type Theme } from '@mui/material/styles'
import { useEffect, useMemo, useState } from 'react'

import { ApiContext, type MusetalkApi } from './lib/api'
import { WSContext, type WSApi } from './lib/ws'
import {
  CapabilitiesContext,
  DEFAULT_CAPABILITIES,
  useCapabilities,
  type Capabilities,
} from './lib/capabilities'
import { StoreProvider, useMusetalkStore } from './lib/store-context'
import { createMusetalkStore } from './store'
import { IconBtn } from './lib/IconBtn'
import { PhotorealFace } from './components/PhotorealFace'
import { MuseTalkRefsDialog } from './components/MuseTalkRefsDialog'
import { AudioDropZone } from './components/AudioDropZone'
import { TextInputCard } from './components/TextInputCard'


export interface V12DashboardProps {
  theme?: Theme
  wsApi?: WSApi
  api: MusetalkApi
  capabilities?: Capabilities
}


/** V12 PhotorealFace dashboard variant + its refs-management dialog.
 *
 *  Composite root for the musetalk satellite UI. Mounted by JarvYZ as
 *  a dashboard variant (via manifest's dashboards[].component) and by
 *  the standalone wrapper SPA as the page's main view.
 *
 *  Creates a per-mount musetalk store bound to the injected api, then
 *  provides Theme / WS / Api / Capabilities / Store contexts before
 *  rendering the inner composite. Same pattern as music + people
 *  satellites — see SATELLITE_DYNAMIC_MODULES.md. */
export function V12Dashboard({ theme, wsApi, api, capabilities }: V12DashboardProps) {
  const caps = capabilities ?? DEFAULT_CAPABILITIES
  const store = useMemo(() => createMusetalkStore(api), [api])

  const inner = (
    <ApiContext.Provider value={api}>
      <WSContext.Provider
        value={wsApi ?? { send: () => {}, subscribe: () => () => {}, isConnected: false }}
      >
        <CapabilitiesContext.Provider value={caps}>
          <StoreProvider value={store}>
            <V12DashboardInner />
          </StoreProvider>
        </CapabilitiesContext.Provider>
      </WSContext.Provider>
    </ApiContext.Provider>
  )

  return theme ? <ThemeProvider theme={theme}>{inner}</ThemeProvider> : inner
}


function V12DashboardInner() {
  const refreshRefs = useMusetalkStore((s) => s.refreshRefs)
  const error = useMusetalkStore((s) => s.musetalk.error)
  const loading = useMusetalkStore((s) => s.musetalk.loading)
  const [refsOpen, setRefsOpen] = useState(false)
  const caps = useCapabilities()

  useEffect(() => {
    void refreshRefs()
  }, [refreshRefs])

  const standalone = caps.deployTarget === 'standalone'

  return (
    <Stack spacing={1}>
      {/* Backend-down signal. If the mount-time refs fetch failed, the
          MuseTalk container is almost certainly not up — without this the
          dashboard renders a blank PhotorealFace canvas with no clue why
          nothing animates. */}
      {!loading && error && (
        <Alert severity="warning" variant="outlined">
          MuseTalk backend unreachable — {error}. The avatar won't animate
          until the MuseTalk container is running.
        </Alert>
      )}

      {/* Synthesis-test row. AudioDropZone is the standalone path
          (wrapper has no TTS — dropping a WAV is the only way to
          trigger frames). TextInputCard is the JarvYZ-embedded path
          (host has TTS — text → /api/say → musetalk dispatch →
          frames on /ws/musetalk_frames → PhotorealFace renders). */}
      {standalone && <AudioDropZone />}
      {!standalone && caps.canSynthesize && <TextInputCard />}

      <PhotorealFace
        topRightActions={
          <IconBtn
            label="MuseTalk references"
            onClick={() => setRefsOpen(true)}
            sx={{ color: '#cfd6e6' }}
            icon={<SettingsIcon />}
          />
        }
      />
      <MuseTalkRefsDialog open={refsOpen} onClose={() => setRefsOpen(false)} />
    </Stack>
  )
}
