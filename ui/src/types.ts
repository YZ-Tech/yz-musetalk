// Shared types for the musetalk satellite UI.

export interface RefItem {
  name: string
  size_bytes: number
  kind: 'image' | 'video'
  duration_s: number | null
  width: number | null
  height: number | null
  /** Only present in JarvYZ-embedded mode. The wrapper itself doesn't
   *  track active state — JarvYZ settings persist that. Standalone
   *  reads `is_active` from satellite store's `activeRef` separately. */
  is_active?: boolean
}

export type DeployTarget = 'jarvis' | 'standalone'
