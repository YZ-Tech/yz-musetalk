// Cross-bundle WS context. Same pattern as music + people satellites
// (see SATELLITE_DYNAMIC_MODULES.md). Host injects WSApi via prop; module wraps
// subtree in WSContext.Provider so module-side useSubscription works.

import { createContext, useContext, useEffect, useRef } from 'react'

export interface WSApi {
  send: (data: unknown) => void
  subscribe: (eventType: string, cb: (data: any) => void) => () => void
  isConnected: boolean
}

const NO_WS: WSApi = {
  send: () => {},
  subscribe: () => () => {},
  isConnected: false,
}

export const WSContext = createContext<WSApi>(NO_WS)

export const useWebSocket = () => useContext(WSContext)

export function useSubscription<T = any>(eventType: string, callback: (data: T) => void) {
  const { subscribe } = useWebSocket()
  const cbRef = useRef(callback)

  useEffect(() => {
    cbRef.current = callback
  })

  useEffect(() => {
    const handler = (data: T) => cbRef.current(data)
    return subscribe(eventType, handler)
  }, [eventType, subscribe])
}
