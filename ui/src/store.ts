// Satellite-internal zustand store for the musetalk page.
//
// Factory pattern: createMusetalkStore(api) returns a store bound to
// the host-provided MusetalkApi. See SATELLITE_DYNAMIC_MODULES.md — store stays
// internal until a second consumer wants the state.

import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { produce } from 'immer'
import type { MusetalkApi } from './lib/api'
import type { RefItem } from './types'


export interface MusetalkSlice {
  refs: RefItem[]
  activeRef: string | null
  loading: boolean
  error: string | null
}


export interface MusetalkState {
  musetalk: MusetalkSlice

  setError: (e: string | null) => void
  refreshRefs: () => Promise<void>
  setActiveRef: (name: string) => Promise<void>
  uploadRef: (file: Blob, filename: string) => Promise<void>
  deleteRef: (name: string) => Promise<void>
}


export type MusetalkStore = UseBoundStore<StoreApi<MusetalkState>>


export function createMusetalkStore(api: MusetalkApi): MusetalkStore {
  return create<MusetalkState>((set) => ({
    musetalk: {
      refs: [],
      activeRef: null,
      loading: true,
      error: null,
    },

    setError: (e) =>
      set(produce((s: MusetalkState) => { s.musetalk.error = e })),

    refreshRefs: async () => {
      try {
        const { items, active } = await api.list()
        set(produce((s: MusetalkState) => {
          s.musetalk.refs = items
          s.musetalk.activeRef = active
          s.musetalk.loading = false
          s.musetalk.error = null
        }))
      } catch (e) {
        set(produce((s: MusetalkState) => {
          s.musetalk.error = e instanceof Error ? e.message : String(e)
          s.musetalk.loading = false
        }))
      }
    },

    setActiveRef: async (name) => {
      try {
        await api.setActive(name)
        set(produce((s: MusetalkState) => {
          s.musetalk.activeRef = name
          s.musetalk.refs = s.musetalk.refs.map((r) =>
            ({ ...r, is_active: r.name === name }),
          )
        }))
      } catch (e) {
        set(produce((s: MusetalkState) => {
          s.musetalk.error = e instanceof Error ? e.message : String(e)
        }))
      }
    },

    uploadRef: async (file, filename) => {
      try {
        const item = await api.uploadRef(file, filename)
        set(produce((s: MusetalkState) => {
          // Replace by name if existed; otherwise append.
          const idx = s.musetalk.refs.findIndex((r) => r.name === item.name)
          if (idx >= 0) s.musetalk.refs[idx] = item
          else s.musetalk.refs.push(item)
        }))
      } catch (e) {
        set(produce((s: MusetalkState) => {
          s.musetalk.error = e instanceof Error ? e.message : String(e)
        }))
      }
    },

    deleteRef: async (name) => {
      try {
        await api.deleteRef(name)
        set(produce((s: MusetalkState) => {
          s.musetalk.refs = s.musetalk.refs.filter((r) => r.name !== name)
        }))
      } catch (e) {
        set(produce((s: MusetalkState) => {
          s.musetalk.error = e instanceof Error ? e.message : String(e)
        }))
      }
    },
  }))
}
