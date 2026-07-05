import { createContext, useContext } from 'react'
import type { DeployTarget } from '../types'

export interface Capabilities {
  apiBase: string
  deployTarget: DeployTarget
  /** Whether the host can synthesize text → audio. JarvYZ-embedded:
   *  true (JarvYZ has piper/chatterbox). Standalone: false (wrapper has no
   *  TTS engine — see SATELLITE_DYNAMIC_MODULES.md / planning notes). The
   *  TextInputCard hides itself when this is false. */
  canSynthesize: boolean
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  apiBase: '',
  deployTarget: 'jarvis',
  canSynthesize: true,
}

export const CapabilitiesContext = createContext<Capabilities>(DEFAULT_CAPABILITIES)

export const useCapabilities = () => useContext(CapabilitiesContext)
