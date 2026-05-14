import { Asset, BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import type { UiNetwork } from "./network.js";
import { horizonAssetRecordToAsset, horizonServer, sdkPassphrase } from "./classicClose.js";

const EPS = 1e-10;

export type CreditTrustlineRow = {
  assetCode: string;
  assetIssuer: string;
  balance: string;
  /** Horizon balance number for comparisons */
  balanceNum: number;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export function parseCreditTrustlinesFromHorizonAccount(raw: Record<string, unknown>): CreditTrustlineRow[] {
  const balances = Array.isArray(raw.balances) ? raw.balances : [];
  const out: CreditTrustlineRow[] = [];
  for (const b of balances) {
    if (!isRecord(b)) continue;
    const t = typeof b.asset_type === "string" ? b.asset_type : "";
    if (t !== "credit_alphanum4" && t !== "credit_alphanum12") continue;
    const assetCode = String(b.asset_code ?? "");
    const assetIssuer = String(b.asset_issuer ?? "");
    const balance = typeof b.balance === "string" ? b.balance : "0";
    const balanceNum = Number(balance);
    if (!assetCode || !assetIssuer || !Number.isFinite(balanceNum)) continue;
    out.push({ assetCode, assetIssuer, balance, balanceNum });
  }
  return out;
}

export async function fetchHorizonAccountJsonFromApi(accountId: string, network: UiNetwork): Promise<Record<string, unknown>> {
  const q = new URLSearchParams({ network });
  const res = await fetch(`/api/account/${encodeURIComponent(accountId)}/horizon?${q}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) throw new Error("Account not found on Horizon for this network.");
  if (!res.ok) throw new Error(`Horizon proxy failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  if (!body.account || typeof body.account !== "object") {
    throw new Error("Horizon proxy returned no account payload.");
  }
  return body.account;
}

export type OrderBookRow = { price: string; amount: string };

export async function fetchOrderBookSellCreditBuyNative(params: {
  network: UiNetwork;
  assetCode: string;
  assetIssuer: string;
}): Promise<{ bids: OrderBookRow[]; asks: OrderBookRow[] }> {
  const q = new URLSearchParams({
    network: params.network,
    asset_code: params.assetCode,
    asset_issuer: params.assetIssuer,
  });
  const res = await fetch(`/api/order-book?${q}`, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Order book fetch failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const body = (await res.json()) as { bids?: OrderBookRow[]; asks?: OrderBookRow[] };
  return {
    bids: Array.isArray(body.bids) ? body.bids : [],
    asks: Array.isArray(body.asks) ? body.asks : [],
  };
}

/** True when the top-of-book cannot absorb a meaningful fraction of `sellAmount`. */
export function orderBookTooThin(sellAmount: string, bids: OrderBookRow[]): boolean {
  if (bids.length === 0) return true;
  const want = Number(sellAmount);
  const top = bids[0];
  const depth = Number(top?.amount ?? "0");
  if (!Number.isFinite(want) || want <= EPS) return true;
  if (!Number.isFinite(depth) || depth <= EPS) return true;
  // Require at least 5% of intended sell size resting at best bid, or tiny absolute dust tolerance
  return depth < want * 0.05 && depth < 1e-5;
}

export function bestBidPrice(bids: OrderBookRow[]): string | null {
  if (bids.length === 0) return null;
  const p = bids[0]?.price;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** Apply slippage (bps) downward to the Horizon best bid price string (XLM per unit selling). */
export function applySlippageToPrice(bestBidPrice: string, slippageBps: number): string {
  const bps = Math.min(5000, Math.max(0, Math.floor(slippageBps)));
  const p = Number(bestBidPrice);
  if (!Number.isFinite(p) || p <= 0) throw new Error("Invalid best bid price.");
  const adj = p * ((10_000 - bps) / 10_000);
  if (!Number.isFinite(adj) || adj <= 0) throw new Error("Slippage produced non-positive price.");
  return adj.toFixed(7);
}

export async function fetchIssuerFlagHints(issuer: string, network: UiNetwork): Promise<string[]> {
  const hints: string[] = [];
  try {
    const raw = await fetchHorizonAccountJsonFromApi(issuer, network);
    const flags = isRecord(raw.flags) ? raw.flags : undefined;
    if (flags && flags.auth_required === true) {
      hints.push("Issuer has AUTH_REQUIRED — payments may need issuer approval.");
    }
    if (flags && flags.clawback_enabled === true) {
      hints.push("Issuer has CLAWBACK_ENABLED — balance movement may be restricted or reversed per issuer policy.");
    }
  } catch {
    hints.push("Could not load issuer account flags from Horizon — verify trust/payment manually.");
  }
  return hints;
}

/**
 * Single crossing `manage_sell_offer` vs native (XLM). Uses full `balance` string from Horizon.
 * TODO: optional path-based exit when no direct SDEX book exists (router / strict-send paths).
 */
export async function buildCrossingSellOfferForXlmXdr(params: {
  horizonUrl: string;
  sourceAccount: string;
  network: UiNetwork;
  assetCode: string;
  assetIssuer: string;
  /** Full precision balance string from Horizon */
  sellAmount: string;
  /** Limit price (buying per selling), after slippage */
  limitPrice: string;
}): Promise<string> {
  const selling = new Asset(params.assetCode, params.assetIssuer);
  const buying = Asset.native();
  const server = horizonServer(params.horizonUrl);
  const account = await server.loadAccount(params.sourceAccount);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: sdkPassphrase(params.network),
  })
    .addOperation(
      Operation.manageSellOffer({
        selling,
        buying,
        amount: params.sellAmount,
        price: params.limitPrice,
        offerId: "0",
      }),
    )
    .setTimeout(180)
    .build();
  return tx.toXDR();
}

/** Pay away full credit balance then remove trust (same ledger tx once balance hits zero). */
export async function buildPaymentAndChangeTrustZeroXdr(params: {
  horizonUrl: string;
  sourceAccount: string;
  network: UiNetwork;
  asset: Asset;
  /** Must match Horizon balance string for the asset */
  amount: string;
  destination: string;
}): Promise<string> {
  const server = horizonServer(params.horizonUrl);
  const account = await server.loadAccount(params.sourceAccount);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: sdkPassphrase(params.network),
  })
    .addOperation(
      Operation.payment({
        destination: params.destination,
        asset: params.asset,
        amount: params.amount,
      }),
    )
    .addOperation(
      Operation.changeTrust({
        asset: params.asset,
        limit: "0",
      }),
    )
    .setTimeout(180)
    .build();
  return tx.toXDR();
}

/** Remove trust for a zero-balance line only. */
export async function buildChangeTrustZeroOnlyXdr(params: {
  horizonUrl: string;
  sourceAccount: string;
  network: UiNetwork;
  balanceRecord: Record<string, unknown>;
}): Promise<string> {
  const asset = horizonAssetRecordToAsset(params.balanceRecord);
  const server = horizonServer(params.horizonUrl);
  const account = await server.loadAccount(params.sourceAccount);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: sdkPassphrase(params.network),
  })
    .addOperation(
      Operation.changeTrust({
        asset,
        limit: "0",
      }),
    )
    .setTimeout(180)
    .build();
  return tx.toXDR();
}
