// Per-mount StoreContext. See SATELLITE_DYNAMIC_MODULES.md — factory pattern,
// store stays internal until a second consumer needs it.

import { createContext, useContext } from 'react'
import type { MusetalkState, MusetalkStore } from '../store'

const StoreContext = createContext<MusetalkStore | null>(null)

export const StoreProvider = StoreContext.Provider

export function useMusetalkStore<T>(selector: (s: MusetalkState) => T): T {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useMusetalkStore called outside StoreProvider')
  return store(selector)
}
