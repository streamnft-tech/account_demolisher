import { BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import type { UiNetwork } from "./network.js";
import type { ClassicBatchResult } from "./classicClose.js";
import { horizonAssetRecordToAsset, horizonServer, sdkPassphrase } from "./classicClose.js";

const MAX_OPS = 100;

type HorizonPage = {
  _embedded?: { records?: unknown[] };
  _links?: { next?: { href?: string | null } | null };
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

async function fetchHorizonPages(horizonUrl: string, relativePath: string): Promise<unknown[]> {
  const base = horizonUrl.replace(/\/?$/, "");
  const out: unknown[] = [];
  let url: string | null = `${base}${relativePath}`;
  const seen = new Set<string>();

  while (url) {
    if (seen.has(url)) break;
    seen.add(url);
    const res = await fetch(url);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Horizon ${res.status} ${url.split("?")[0]}: ${t.slice(0, 280)}`);
    }
    const json = (await res.json()) as HorizonPage;
    const recs = json._embedded?.records ?? [];
    out.push(...recs);
    const next = json._links?.next?.href;
    url = recs.length > 0 && typeof next === "string" && next.length > 0 ? next : null;
  }
  return out;
}

/** Build up to {@link MAX_OPS} `RevokeSponsorship` operations paid by `sponsorAccountId`. */
export async function buildRevokeSponsorshipBatchXdr(params: {
  horizonUrl: string;
  sponsorAccountId: string;
  network: UiNetwork;
}): Promise<ClassicBatchResult> {
  const sponsor = params.sponsorAccountId;
  const q = (path: string) =>
    `${path}?${new URLSearchParams({ sponsor, limit: "50", order: "asc" }).toString()}`;

  const [claimables, offers, pools, sponsoredAccounts] = await Promise.all([
    fetchHorizonPages(params.horizonUrl, q("/claimable_balances")),
    fetchHorizonPages(params.horizonUrl, q("/offers")),
    fetchHorizonPages(params.horizonUrl, q("/liquidity_pools")),
    fetchHorizonPages(params.horizonUrl, q("/accounts")),
  ]);

  const claimableOps = [];
  const offerOps = [];
  const poolOps = [];
  const trustOps = [];
  const signerOps = [];
  const accountOps = [];

  const seenPool = new Set<string>();

  for (const r of claimables) {
    if (!isRecord(r)) continue;
    const id = typeof r.id === "string" ? r.id : "";
    const sp = typeof r.sponsor === "string" ? r.sponsor : "";
    if (!id || sp !== sponsor) continue;
    claimableOps.push(
      Operation.revokeClaimableBalanceSponsorship({
        balanceId: id,
      }),
    );
  }

  for (const r of offers) {
    if (!isRecord(r)) continue;
    const sp = typeof r.sponsor === "string" ? r.sponsor : "";
    if (sp !== sponsor) continue;
    const seller = typeof r.seller === "string" ? r.seller : "";
    const offerId = String(r.id ?? "");
    if (!seller || !offerId) continue;
    offerOps.push(
      Operation.revokeOfferSponsorship({
        seller,
        offerId,
      }),
    );
  }

  for (const r of pools) {
    if (!isRecord(r)) continue;
    /* `sponsor=` filter already scopes to this sponsor; pool records may omit `sponsor` field. */
    const poolId = typeof r.id === "string" ? r.id : "";
    if (!poolId || seenPool.has(poolId)) continue;
    seenPool.add(poolId);
    poolOps.push(
      Operation.revokeLiquidityPoolSponsorship({
        liquidityPoolId: poolId,
      }),
    );
  }

  for (const raw of sponsoredAccounts) {
    if (!isRecord(raw)) continue;
    const accId = typeof raw.id === "string" ? raw.id : "";
    if (!accId) continue;

    const balances = Array.isArray(raw.balances) ? raw.balances : [];
    for (const b of balances) {
      if (!isRecord(b)) continue;
      const bSponsor = typeof b.sponsor === "string" ? b.sponsor : "";
      if (bSponsor !== sponsor) continue;
      const assetType = typeof b.asset_type === "string" ? b.asset_type : "";
      if (assetType === "credit_alphanum4" || assetType === "credit_alphanum12") {
        trustOps.push(
          Operation.revokeTrustlineSponsorship({
            account: accId,
            asset: horizonAssetRecordToAsset(b),
          }),
        );
      } else if (assetType === "liquidity_pool_shares") {
        const poolId =
          (typeof b.liquidity_pool_id === "string" && b.liquidity_pool_id) ||
          (typeof (b as { liquidty_pool_id?: string }).liquidty_pool_id === "string"
            ? (b as { liquidty_pool_id?: string }).liquidty_pool_id
            : "");
        if (poolId && !seenPool.has(poolId)) {
          seenPool.add(poolId);
          trustOps.push(
            Operation.revokeLiquidityPoolSponsorship({
              liquidityPoolId: poolId,
            }),
          );
        }
      }
    }

    const signers = Array.isArray(raw.signers) ? raw.signers : [];
    for (const s of signers) {
      if (!isRecord(s)) continue;
      const sSponsor = typeof s.sponsor === "string" ? s.sponsor : "";
      if (sSponsor !== sponsor) continue;
      const key = typeof s.key === "string" ? s.key : "";
      const typ = typeof s.type === "string" ? s.type : "";
      if (typ === "ed25519_public_key" && key) {
        signerOps.push(
          Operation.revokeSignerSponsorship({
            account: accId,
            signer: { ed25519PublicKey: key },
          }),
        );
      }
    }

    const acctSponsor = typeof raw.sponsor === "string" ? raw.sponsor : "";
    if (acctSponsor === sponsor) {
      accountOps.push(
        Operation.revokeAccountSponsorship({
          account: accId,
        }),
      );
    }
  }

  const ordered = [...claimableOps, ...offerOps, ...poolOps, ...trustOps, ...signerOps, ...accountOps];

  const totalDiscovered = ordered.length;
  const slice = ordered.slice(0, MAX_OPS);
  const truncated = totalDiscovered > MAX_OPS;

  const server = horizonServer(params.horizonUrl);
  const source = await server.loadAccount(sponsor);
  let b = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: sdkPassphrase(params.network),
  });
  for (const op of slice) {
    b = b.addOperation(op);
  }

  const xdr = b.setTimeout(180).build().toXDR();
  return {
    xdr,
    opCount: slice.length,
    totalDiscovered,
    truncated,
    followUpHint: truncated
      ? "More sponsored entries remain — run again after this transaction confirms."
      : undefined,
  };
}
