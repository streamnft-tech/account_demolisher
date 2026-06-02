import type { FastifyBaseLogger } from "fastify";
import type { SponsoredLedgerEntry } from "@stellar/core";

import { resolveHorizonBase, type LedgerQueryNetwork } from "./horizon.js";

type HorizonPage = {
  _embedded?: { records?: unknown[] };
  _links?: { next?: { href?: string | null } | null };
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function compactKey(key: string): string {
  if (key.length <= 18) return key;
  return `${key.slice(0, 8)}...${key.slice(-6)}`;
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

function assetLabel(record: Record<string, unknown>): string {
  const assetType = typeof record.asset_type === "string" ? record.asset_type : "";
  if (assetType === "liquidity_pool_shares") return "Liquidity pool shares";
  const code = typeof record.asset_code === "string" ? record.asset_code : "";
  const issuer = typeof record.asset_issuer === "string" ? record.asset_issuer : "";
  if (code && issuer) return `${code} from ${compactKey(issuer)}`;
  return assetType || "Asset";
}

export async function fetchSponsoredEntriesForSponsor(
  sponsorAccountId: string,
  network: LedgerQueryNetwork,
  log?: FastifyBaseLogger,
): Promise<SponsoredLedgerEntry[]> {
  const horizonUrl = resolveHorizonBase(network);
  const sponsor = sponsorAccountId;
  const q = (path: string) =>
    `${path}?${new URLSearchParams({ sponsor, limit: "50", order: "asc" }).toString()}`;

  try {
    const [claimables, offers, pools, sponsoredAccounts] = await Promise.all([
      fetchHorizonPages(horizonUrl, q("/claimable_balances")),
      fetchHorizonPages(horizonUrl, q("/offers")),
      fetchHorizonPages(horizonUrl, q("/liquidity_pools")),
      fetchHorizonPages(horizonUrl, q("/accounts")),
    ]);

    const entries: SponsoredLedgerEntry[] = [];
    const seen = new Set<string>();
    const add = (entry: SponsoredLedgerEntry) => {
      const key = `${entry.type}:${entry.id}:${entry.accountId ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push(entry);
    };

    for (const r of claimables) {
      if (!isRecord(r)) continue;
      const id = typeof r.id === "string" ? r.id : "";
      const sp = typeof r.sponsor === "string" ? r.sponsor : "";
      if (!id || sp !== sponsor) continue;
      add({
        type: "claimable_balance",
        id,
        label: "Claimable balance",
        detail: compactKey(id),
      });
    }

    for (const r of offers) {
      if (!isRecord(r)) continue;
      const sp = typeof r.sponsor === "string" ? r.sponsor : "";
      if (sp !== sponsor) continue;
      const seller = typeof r.seller === "string" ? r.seller : "";
      const offerId = String(r.id ?? "");
      if (!seller || !offerId) continue;
      add({
        type: "offer",
        id: offerId,
        accountId: seller,
        label: "Open offer sponsorship",
        detail: `Offer #${offerId} by ${compactKey(seller)}`,
      });
    }

    for (const r of pools) {
      if (!isRecord(r)) continue;
      const poolSponsor = typeof r.sponsor === "string" ? r.sponsor : "";
      const poolId = typeof r.id === "string" ? r.id : "";
      if (!poolId || poolSponsor !== sponsor) continue;
      add({
        type: "liquidity_pool",
        id: poolId,
        label: "Liquidity pool sponsorship",
        detail: compactKey(poolId),
      });
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
          add({
            type: "trustline",
            id: `${accId}:${assetLabel(b)}`,
            accountId: accId,
            label: "Trustline sponsorship",
            detail: assetLabel(b),
          });
        } else if (assetType === "liquidity_pool_shares") {
          const poolId =
            (typeof b.liquidity_pool_id === "string" && b.liquidity_pool_id) ||
            (typeof (b as { liquidty_pool_id?: string }).liquidty_pool_id === "string"
              ? (b as { liquidty_pool_id?: string }).liquidty_pool_id
              : "");
          if (poolId) {
            add({
              type: "liquidity_pool",
              id: poolId,
              accountId: accId,
              label: "Liquidity pool sponsorship",
              detail: `${compactKey(poolId)} held by ${compactKey(accId)}`,
            });
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
          add({
            type: "signer",
            id: key,
            accountId: accId,
            label: "Signer sponsorship",
            detail: `${compactKey(key)} on ${compactKey(accId)}`,
          });
        }
      }

      const acctSponsor = typeof raw.sponsor === "string" ? raw.sponsor : "";
      if (acctSponsor === sponsor) {
        add({
          type: "account",
          id: accId,
          accountId: accId,
          label: "Account sponsorship",
          detail: compactKey(accId),
        });
      }
    }

    return entries;
  } catch (err) {
    log?.warn({ err, sponsorAccountId }, "sponsored entries scan failed");
    return [];
  }
}
