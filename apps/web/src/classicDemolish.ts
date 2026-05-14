import type { LpShareRow, SdexOfferRow } from "@stellar/core";
import { extractLiquidityPoolSharesFromHorizonBalances } from "@stellar/core";
import { BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import type { UiNetwork } from "./network.js";
import {
  buildCancelSdexOffersXdr,
  horizonAssetRecordToAsset,
  horizonServer,
  sdkPassphrase,
  type ClassicBatchResult,
} from "./classicClose.js";

const MAX_OPS = 100;

export type { ClassicBatchResult } from "./classicClose.js";

export async function fetchHorizonAccountRecord(horizonUrl: string, accountId: string): Promise<Record<string, unknown>> {
  const base = horizonUrl.replace(/\/?$/, "");
  const res = await fetch(`${base}/accounts/${encodeURIComponent(accountId)}`);
  if (res.status === 404) throw new Error("Account not found on this Horizon.");
  if (!res.ok) throw new Error((await res.text()).slice(0, 280));
  return (await res.json()) as Record<string, unknown>;
}

function parseBalance(s: string | undefined): number {
  if (s === undefined) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** Remove up to {@link MAX_OPS} `ManageData` entries (value `null` = delete). */
export async function buildClearDataEntriesBatchXdr(params: {
  horizonUrl: string;
  sourceAccount: string;
  network: UiNetwork;
}): Promise<ClassicBatchResult> {
  const raw = await fetchHorizonAccountRecord(params.horizonUrl, params.sourceAccount);
  const data = raw.data;
  const keys =
    data && typeof data === "object" && !Array.isArray(data)
      ? Object.keys(data as Record<string, unknown>).filter((k) => k.length > 0 && k.length <= 64)
      : [];
  if (keys.length === 0) {
    throw new Error("No data entries found on Horizon for this account.");
  }
  const slice = keys.slice(0, MAX_OPS);
  const server = horizonServer(params.horizonUrl);
  const account = await server.loadAccount(params.sourceAccount);
  let b = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: sdkPassphrase(params.network),
  });
  for (const name of slice) {
    b = b.addOperation(
      Operation.manageData({
        name,
        value: null,
      }),
    );
  }
  return {
    xdr: b.setTimeout(180).build().toXDR(),
    opCount: slice.length,
    truncated: keys.length > MAX_OPS,
    totalDiscovered: keys.length,
    followUpHint: keys.length > MAX_OPS ? "More data keys remain — run again after this transaction confirms." : undefined,
  };
}

/** `ChangeTrust` limit 0 for credit lines with zero balance. Fails if any non-native credit line has positive balance. */
export async function buildRemoveEmptyTrustlinesBatchXdr(params: {
  horizonUrl: string;
  sourceAccount: string;
  network: UiNetwork;
}): Promise<ClassicBatchResult> {
  const raw = await fetchHorizonAccountRecord(params.horizonUrl, params.sourceAccount);
  const balances = Array.isArray(raw.balances) ? raw.balances : [];
  const positives: string[] = [];
  const toRemove: { asset: ReturnType<typeof horizonAssetRecordToAsset> }[] = [];
  for (const b of balances) {
    if (!isRecord(b)) continue;
    const t = typeof b.asset_type === "string" ? b.asset_type : "";
    if (t === "native") continue;
    if (t === "liquidity_pool_shares") continue;
    if (t !== "credit_alphanum4" && t !== "credit_alphanum12") continue;
    const bal = parseBalance(typeof b.balance === "string" ? b.balance : undefined);
    const code = String(b.asset_code ?? "");
    const issuer = String(b.asset_issuer ?? "");
    const label = `${code}:${issuer.slice(0, 6)}…`;
    if (bal > 1e-7) {
      positives.push(label);
      continue;
    }
    toRemove.push({ asset: horizonAssetRecordToAsset(b) });
  }
  if (positives.length > 0) {
    throw new Error(
      `Cannot remove trustlines while balances are non-zero: ${positives.slice(0, 6).join(", ")}${positives.length > 6 ? "…" : ""}. Sell or send assets first, then re-run.`,
    );
  }
  if (toRemove.length === 0) {
    throw new Error("No zero-balance classic trustlines to remove.");
  }
  const slice = toRemove.slice(0, MAX_OPS);
  const server = horizonServer(params.horizonUrl);
  const account = await server.loadAccount(params.sourceAccount);
  let tb = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: sdkPassphrase(params.network),
  });
  for (const { asset } of slice) {
    tb = tb.addOperation(
      Operation.changeTrust({
        asset,
        limit: "0",
      }),
    );
  }
  return {
    xdr: tb.setTimeout(180).build().toXDR(),
    opCount: slice.length,
    truncated: toRemove.length > MAX_OPS,
    totalDiscovered: toRemove.length,
    followUpHint:
      toRemove.length > MAX_OPS ? "More empty trustlines remain — run again after this transaction confirms." : undefined,
  };
}

/** Up to {@link MAX_OPS} `liquidityPoolWithdraw` ops (min amounts 0 — high slippage; confirm in wallet). */
export async function buildWithdrawLiquidityPoolsBatchXdr(params: {
  horizonUrl: string;
  sourceAccount: string;
  network: UiNetwork;
  pools: LpShareRow[];
}): Promise<ClassicBatchResult> {
  let pools = params.pools.filter((p) => p.poolId && parseBalance(p.balance) > 1e-7);
  if (pools.length === 0) {
    const raw = await fetchHorizonAccountRecord(params.horizonUrl, params.sourceAccount);
    pools = extractLiquidityPoolSharesFromHorizonBalances(
      raw.balances as Array<Record<string, unknown>> | undefined,
    ).filter((p) => parseBalance(p.balance) > 1e-7);
  }
  if (pools.length === 0) throw new Error("No liquidity pool share balances to withdraw.");
  const slice = pools.slice(0, MAX_OPS);
  const server = horizonServer(params.horizonUrl);
  const account = await server.loadAccount(params.sourceAccount);
  let tb = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: sdkPassphrase(params.network),
  });
  for (const pool of slice) {
    tb = tb.addOperation(
      Operation.liquidityPoolWithdraw({
        liquidityPoolId: pool.poolId,
        amount: pool.balance,
        minAmountA: "0",
        minAmountB: "0",
      }),
    );
  }
  return {
    xdr: tb.setTimeout(180).build().toXDR(),
    opCount: slice.length,
    truncated: pools.length > MAX_OPS,
    totalDiscovered: pools.length,
    followUpHint:
      pools.length > MAX_OPS ? "More pool positions remain — run again after this transaction confirms." : undefined,
  };
}

export async function fetchOpenOffersFromApi(accountId: string, network: UiNetwork): Promise<SdexOfferRow[]> {
  const q = new URLSearchParams({ network });
  const res = await fetch(`/api/account/${encodeURIComponent(accountId)}/offers?${q}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Offers fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { offers?: SdexOfferRow[] };
  return body.offers ?? [];
}

export async function buildCancelOpenOffersBatchXdr(params: {
  horizonUrl: string;
  sourceAccount: string;
  network: UiNetwork;
  offers: SdexOfferRow[];
}): Promise<ClassicBatchResult> {
  if (params.offers.length === 0) throw new Error("No open offers returned for this account.");
  const xdr = await buildCancelSdexOffersXdr({
    horizonUrl: params.horizonUrl,
    sourceAccount: params.sourceAccount,
    offers: params.offers,
    network: params.network,
  });
  const opCount = Math.min(params.offers.length, MAX_OPS);
  return {
    xdr,
    opCount,
    truncated: params.offers.length > MAX_OPS,
    totalDiscovered: params.offers.length,
    followUpHint:
      params.offers.length > MAX_OPS ? "More than 100 offers — run again after this transaction confirms." : undefined,
  };
}

export async function fetchClaimableBalanceIdsFromApi(accountId: string, network: UiNetwork): Promise<string[]> {
  const q = new URLSearchParams({ network });
  const res = await fetch(`/api/account/${encodeURIComponent(accountId)}/claimable-balances?${q}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Claimable balances fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { claimableBalances?: Array<{ id?: string }> };
  const rows = body.claimableBalances ?? [];
  return rows.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

export async function buildClaimClaimableBalancesBatchXdr(params: {
  horizonUrl: string;
  sourceAccount: string;
  network: UiNetwork;
  balanceIds: string[];
}): Promise<ClassicBatchResult> {
  if (params.balanceIds.length === 0) throw new Error("No inbound claimable balances to claim.");
  const slice = params.balanceIds.slice(0, MAX_OPS);
  const server = horizonServer(params.horizonUrl);
  const account = await server.loadAccount(params.sourceAccount);
  let tb = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: sdkPassphrase(params.network),
  });
  for (const balanceId of slice) {
    tb = tb.addOperation(
      Operation.claimClaimableBalance({
        balanceId,
      }),
    );
  }
  return {
    xdr: tb.setTimeout(180).build().toXDR(),
    opCount: slice.length,
    truncated: params.balanceIds.length > MAX_OPS,
    totalDiscovered: params.balanceIds.length,
    followUpHint:
      params.balanceIds.length > MAX_OPS
        ? "More claimable balances remain — run again after this transaction confirms."
        : undefined,
  };
}

function thresholdsMergeFriendly(th: Record<string, unknown> | undefined): boolean {
  if (!th) return true;
  const low = typeof th.low_threshold === "number" ? th.low_threshold : 1;
  const med = typeof th.med_threshold === "number" ? th.med_threshold : 0;
  const high = typeof th.high_threshold === "number" ? th.high_threshold : 0;
  return low <= 1 && med === 0 && high === 0;
}

/**
 * Phase A (while extra ed25519 signers exist): remove up to 100 at a time (`weight: 0`).
 * Phase B (no extra signers): set `masterWeight: 1` and merge-friendly thresholds.
 */
export async function buildMergeFriendlySignersAndThresholdsBatchXdr(params: {
  horizonUrl: string;
  sourceAccount: string;
  network: UiNetwork;
}): Promise<ClassicBatchResult> {
  const raw = await fetchHorizonAccountRecord(params.horizonUrl, params.sourceAccount);
  const id = typeof raw.id === "string" ? raw.id : params.sourceAccount;
  const signers = Array.isArray(raw.signers) ? raw.signers : [];
  const th = isRecord(raw.thresholds) ? raw.thresholds : undefined;

  const extras = signers.filter((s) => {
    if (!isRecord(s)) return false;
    const key = typeof s.key === "string" ? s.key : "";
    const typ = typeof s.type === "string" ? s.type : "";
    return key && key !== id && typ === "ed25519_public_key";
  }) as Array<Record<string, unknown>>;

  const master = signers.find((s) => isRecord(s) && (s as { key?: string }).key === id) as
    | { weight?: number; key?: string }
    | undefined;
  const masterWeight = typeof master?.weight === "number" ? master.weight : 1;
  const thOk = thresholdsMergeFriendly(th as Record<string, unknown> | undefined);
  const masterOk = masterWeight === 1;

  const server = horizonServer(params.horizonUrl);
  const account = await server.loadAccount(params.sourceAccount);

  if (extras.length > 0) {
    const slice = extras.slice(0, MAX_OPS);
    let tb = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: sdkPassphrase(params.network),
    });
    for (const s of slice) {
      const key = String(s.key ?? "");
      tb = tb.addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: key,
            weight: 0,
          },
        }),
      );
    }
    return {
      xdr: tb.setTimeout(180).build().toXDR(),
      opCount: slice.length,
      truncated: extras.length > MAX_OPS,
      totalDiscovered: extras.length,
      followUpHint:
        extras.length > MAX_OPS
          ? "More extra signers remain — run again. Then run once more to fix thresholds/master weight if needed."
          : !thOk || !masterOk
            ? "Re-run after confirm to apply merge-friendly thresholds and master weight (next batch)."
            : undefined,
    };
  }

  if (masterOk && thOk) {
    throw new Error("Account already has merge-friendly thresholds and no extra signers.");
  }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: sdkPassphrase(params.network),
  })
    .addOperation(
      Operation.setOptions({
        masterWeight: 1,
        lowThreshold: 1,
        medThreshold: 0,
        highThreshold: 0,
      }),
    )
    .setTimeout(180)
    .build();

  return {
    xdr: tx.toXDR(),
    opCount: 1,
    truncated: false,
    totalDiscovered: 1,
  };
}
