// IIFE entry. Exports surface on window.YzMusetalk for JarvYZ to consume
// via @yz-dev/react-dynamic-module. See SATELLITE_DYNAMIC_MODULES.md.
export { V12Dashboard } from './V12Dashboard'
export type { V12DashboardProps } from './V12Dashboard'

export type { WSApi } from './lib/ws'
export type { Capabilities } from './lib/capabilities'
export { createSatelliteApi } from './lib/api'
export type { MusetalkApi } from './lib/api'
export type { RefItem, DeployTarget } from './types'
