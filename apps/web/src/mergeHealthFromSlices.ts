import type {
  DefiProtocolSurface,
  HealthReport,
  HorizonAccountShape,
  SorobanScanResult,
  SdexOfferRow,
} from "@stellar/core";
import {
  buildHealthReport,
  defiProtocolSurfacesForNetwork,
  extractLiquidityPoolSharesFromHorizonBalances,
} from "@stellar/core";

import type { UiNetwork } from "./network.js";

export type AsyncSlice<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; message: string };

export const idleSlice = { status: "idle" } as const;

export type HorizonSlicePayload = {
  ledgerNetwork: "testnet" | "mainnet" | "custom";
  horizonUrl: string;
  sorobanRpcUrl: string;
  account: HorizonAccountShape | null;
};

export function emptySorobanResult(rpcUrl: string): SorobanScanResult {
  return {
    rpcUrl,
    ok: true,
    balances: [],
    allowances: [],
    allowanceCheckIncomplete: true,
  };
}

/** Map UI network tab to ledger label used by the API (custom Horizon env is still labeled in API response). */
function ledgerFromUi(ui: UiNetwork, ledgerNetwork: HorizonSlicePayload["ledgerNetwork"]): "testnet" | "mainnet" {
  if (ledgerNetwork === "mainnet") return "mainnet";
  return ui === "mainnet" ? "mainnet" : "testnet";
}

/**
 * Build the same `HealthReport` the monolithic `/health` endpoint produced, from independently fetched slices.
 */
export function mergeHealthFromSlices(
  accountId: string,
  uiNetwork: UiNetwork,
  horizon: HorizonSlicePayload,
  offers: SdexOfferRow[],
  soroban: SorobanScanResult,
  defiProtocols?: DefiProtocolSurface[],
): HealthReport {
  const defiNet = ledgerFromUi(uiNetwork, horizon.ledgerNetwork);

  if (!horizon.account) {
    return buildHealthReport({
      accountId,
      ledgerNetwork: horizon.ledgerNetwork,
      horizonUrl: horizon.horizonUrl,
      sorobanRpcUrl: horizon.sorobanRpcUrl,
      horizonAccount: null,
      offersCount: 0,
      soroban: emptySorobanResult(horizon.sorobanRpcUrl),
      openPositions: null,
    });
  }

  const liquidityPoolShares = extractLiquidityPoolSharesFromHorizonBalances(
    horizon.account.balances as Array<Record<string, unknown>> | undefined,
  );

  return buildHealthReport({
    accountId,
    ledgerNetwork: horizon.ledgerNetwork,
    horizonUrl: horizon.horizonUrl,
    sorobanRpcUrl: horizon.sorobanRpcUrl,
    horizonAccount: horizon.account,
    offersCount: offers.length,
    soroban,
    openPositions: {
      sdexOffers: offers,
      liquidityPoolShares,
      defiProtocols: defiProtocols ?? defiProtocolSurfacesForNetwork(defiNet),
    },
  });
}

export type HealthFetchBundle = {
  horizon: AsyncSlice<HorizonSlicePayload>;
  offers: AsyncSlice<{ offers: SdexOfferRow[] }>;
  soroban: AsyncSlice<{ soroban: SorobanScanResult; defiProtocols?: DefiProtocolSurface[] }>;
};

/** When every slice is `ok`, returns the same report as `GET .../health`; otherwise `null`. */
export function buildMergedReportOrNull(accountId: string, uiNetwork: UiNetwork, bundle: HealthFetchBundle): HealthReport | null {
  const { horizon, offers, soroban } = bundle;
  if (horizon.status !== "ok" || offers.status !== "ok" || soroban.status !== "ok") return null;
  return mergeHealthFromSlices(
    accountId.trim(),
    uiNetwork,
    horizon.data,
    offers.data.offers,
    soroban.data.soroban,
    soroban.data.defiProtocols,
  );
}
