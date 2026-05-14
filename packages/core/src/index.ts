/** Shared types and pure helpers for Account Demolisher */

export type {
  StellarNetwork,
  BlockerCode,
  Blocker,
  HealthReport,
  HorizonAccountShape,
  BuildHealthReportInput,
  SorobanScanResult,
  HealthChecklistItem,
  ChecklistStatus,
} from "./health.js";
export type { DefiProtocolSurface, LpShareRow, OpenPositionsSnapshot, SdexOfferRow } from "./positions.js";
export { defiProtocolSurfacesForNetwork, extractLiquidityPoolSharesFromHorizonBalances } from "./positions.js";
export {
  isValidClassicAddress,
  analyzeAccountHealth,
  buildHealthReport,
  placeholderSnapshot,
  type AccountSnapshotPlaceholder,
} from "./health.js";
