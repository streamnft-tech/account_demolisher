import type { FastifyBaseLogger } from "fastify";
import type { SdexOfferRow } from "@stellar/core";
import { resolveHorizonBase, type LedgerQueryNetwork } from "./horizon.js";
import { logUpstream } from "./upstreamLog.js";

const MAX_OFFER_PAGES = 400;

function horizonAssetToLabel(asset: Record<string, unknown>): string {
  const t = (typeof asset.asset_type === "string" ? asset.asset_type : undefined) ?? (typeof asset.type === "string" ? asset.type : undefined);
  if (t === "native") return "native";
  if (t === "credit_alphanum4" || t === "credit_alphanum12") {
    const code = typeof asset.asset_code === "string" ? asset.asset_code : typeof asset.code === "string" ? asset.code : "?";
    const issuer =
      typeof asset.asset_issuer === "string" ? asset.asset_issuer : typeof asset.issuer === "string" ? asset.issuer : "?";
    return `${code}:${issuer}`;
  }
  if (t === "liquidity_pool_shares") {
    const pid = typeof asset.liquidity_pool_id === "string" ? asset.liquidity_pool_id : "";
    return `liquidity_pool:${pid}`;
  }
  return t ?? JSON.stringify(asset);
}

/**
 * Paginate Horizon `/offers` for the seller account (open SDEX offers).
 * Guards against runaway pagination (bad `next` links) which would otherwise hang the `/offers` API.
 */
export async function fetchSdexOffersForSeller(
  accountId: string,
  network: LedgerQueryNetwork,
  log?: FastifyBaseLogger,
): Promise<SdexOfferRow[]> {
  const base = resolveHorizonBase(network);
  let url: string | null = `${base}/offers?seller=${encodeURIComponent(accountId)}&limit=200&order=asc`;
  const out: SdexOfferRow[] = [];
  const seenUrls = new Set<string>();
  let page = 0;

  while (url) {
    if (seenUrls.has(url)) {
      logUpstream(log, "horizon_offers_cycle", { accountId, url, totalOffers: out.length });
      break;
    }
    seenUrls.add(url);
    page += 1;
    if (page > MAX_OFFER_PAGES) {
      throw new Error(
        `Horizon offers pagination stopped after ${MAX_OFFER_PAGES} pages (${out.length} offers) — safety limit.`,
      );
    }

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) {
      logUpstream(log, "horizon_offers_error", { accountId, url, status: res.status }, text);
      throw new Error(`Horizon offers error ${res.status}: ${text}`);
    }
    let body: {
      _embedded?: { records?: Array<Record<string, unknown>> };
      _links?: { next?: { href?: string } };
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      logUpstream(log, "horizon_offers_bad_json", { accountId, url, status: res.status }, text);
      throw new Error(`Horizon offers: invalid JSON from ${url}`);
    }
    const recs = body._embedded?.records ?? [];
    const nextHref = body._links?.next?.href;
    let nextUrl: string | null = null;
    if (typeof nextHref === "string" && nextHref.length > 0) {
      if (nextHref.startsWith("http")) {
        nextUrl = nextHref;
      } else {
        try {
          nextUrl = new URL(nextHref, base).toString();
        } catch {
          logUpstream(log, "horizon_offers_bad_next_url", { accountId, url, nextHref });
          nextUrl = null;
        }
      }
    }

    logUpstream(log, "horizon_offers_page", {
      accountId,
      page,
      url,
      status: res.status,
      recordCount: recs.length,
      totalSoFar: out.length + recs.length,
      hasNext: Boolean(nextUrl),
    });

    for (const r of recs) {
      const selling = r.selling as Record<string, unknown> | undefined;
      const buying = r.buying as Record<string, unknown> | undefined;
      out.push({
        id: String(r.id ?? ""),
        selling: selling ? horizonAssetToLabel(selling) : "?",
        buying: buying ? horizonAssetToLabel(buying) : "?",
        amount: String(r.amount ?? "0"),
        price: String(r.price ?? "0"),
        sellingAsset: selling ?? {},
        buyingAsset: buying ?? {},
      });
    }

    if (nextUrl === url) {
      logUpstream(log, "horizon_offers_next_equals_current", { accountId, url });
      break;
    }
    url = nextUrl;
  }

  logUpstream(log, "horizon_offers_done", { accountId, pages: page, totalOffers: out.length });
  return out;
}
