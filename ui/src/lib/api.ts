// Semantic API contract for the musetalk module.
//
// Two adapters ship with the bundle:
//   - createSatelliteApi() — talks directly to the wrapper container's
//     own routes (/refs, /set_active, ws://.../ws/say). Used by App.tsx
//     when the UI is served standalone by the wrapper.
//   - The JarvYZ-embedded host (frontend/src/pages/Face/...) provides
//     its own adapter wrapping `/api/musetalk/*` JarvYZ proxy routes.

import { createContext, useContext } from 'react'
import type { RefItem } from '../types'


/** The complete API surface the musetalk module needs from its host. */
export interface MusetalkApi {
  // Refs CRUD
  list(): Promise<{ items: RefItem[]; active: string | null }>
  uploadRef(file: Blob, filename: string): Promise<RefItem>
  deleteRef(name: string): Promise<{ deleted: string }>
  setActive(name: string): Promise<{ active: string; wrapper_ok?: boolean }>

  /** Browser-loadable URL for the raw ref bytes (img.src / video.src). */
  refUrl(name: string): string

  /** WS URL the V12 viewer subscribes to for the JPG frame stream.
   *  JarvYZ: ws://host/ws/musetalk_frames (the re-broadcast WS).
   *  Standalone: the wrapper itself doesn't have a "re-broadcast";
   *  the viewer connects directly to /ws/say's output during testing,
   *  which only emits during synthesis. So standalone's viewer mostly
   *  shows the backdrop until the user drops audio. */
  framesWsUrl(): string

  /** WS URL for direct WAV-bytes synthesis. Used by AudioDropZone.
   *  Same wire format in both modes (it's the wrapper's /ws/say). */
  sayWsUrl(): string

  /** Synthesize text → WAV bytes. JarvYZ-embedded only (host has TTS).
   *  Standalone hosts return undefined to indicate not-supported. */
  synthesizeText?(text: string): Promise<Blob>
}


// ---------------------------------------------------------------------------


const NO_API: MusetalkApi = {
  list: () => Promise.reject(new Error('no api')),
  uploadRef: () => Promise.reject(new Error('no api')),
  deleteRef: () => Promise.reject(new Error('no api')),
  setActive: () => Promise.reject(new Error('no api')),
  refUrl: () => '',
  framesWsUrl: () => '',
  sayWsUrl: () => '',
}

export const ApiContext = createContext<MusetalkApi>(NO_API)
export const useApi = () => useContext(ApiContext)


// ---------------------------------------------------------------------------
// Standalone adapter — wrapper routes directly (no JarvYZ proxy).
// `apiBase` is empty when served same-origin (wrapper /static).


function wsOrigin(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}`
}


export function createSatelliteApi(
  { apiBase = '' }: { apiBase?: string } = {},
): MusetalkApi {
  async function jget<T>(path: string): Promise<T> {
    const r = await fetch(apiBase + path)
    if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text().catch(() => '')}`)
    return r.json()
  }
  async function jdelete<T>(path: string): Promise<T> {
    const r = await fetch(apiBase + path, { method: 'DELETE' })
    if (!r.ok) throw new Error(`DELETE ${path} → ${r.status} ${await r.text().catch(() => '')}`)
    return r.json()
  }

  return {
    list: async () => {
      // The wrapper's /refs returns just {items}. The JarvYZ-side
      // proxy at /api/musetalk/refs returns {items, active} where
      // `active` is the user's persisted choice (lives in
      // settings.voice.musetalk_active_ref on the JarvYZ side, which
      // the wrapper itself doesn't know about). One adapter handles
      // both shapes: parse `active` if present, else null.
      const data = await jget<{ items: RefItem[]; active?: string | null }>('/refs')
      return { items: data.items, active: data.active ?? null }
    },

    uploadRef: async (file, filename) => {
      const form = new FormData()
      form.append('file', file, filename)
      const r = await fetch(apiBase + '/refs', { method: 'POST', body: form })
      if (!r.ok) throw new Error(`upload → ${r.status} ${await r.text().catch(() => '')}`)
      return r.json()
    },

    deleteRef: (name) => jdelete(`/refs/${encodeURIComponent(name)}`),

    setActive: async (name) => {
      // POST {ref} matches both the wrapper's `/set_active` and the
      // JarvYZ-side proxy at `/api/musetalk/set_active` — same shape,
      // same verb, so one adapter line works in both modes.
      const r = await fetch(apiBase + '/set_active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: name }),
      })
      if (!r.ok) throw new Error(`set_active → ${r.status} ${await r.text().catch(() => '')}`)
      const data = await r.json()
      return { active: name, wrapper_ok: data.wrapper_ok ?? data.ok }
    },

    refUrl: (name) => `${apiBase}/refs/${encodeURIComponent(name)}`,

    // Standalone has no JarvYZ re-broadcast WS. Returning the wrapper's
    // /ws/say is technically wrong shape — but in practice V12
    // standalone connects to the same WS the AudioDropZone uses, just
    // as a read-only subscriber. Phase 4 may refactor this.
    framesWsUrl: () => `${wsOrigin()}/ws/say`,
    sayWsUrl: () => `${wsOrigin()}/ws/say`,

    // No synthesizeText in standalone — wrapper has no TTS engine.
  }
}
