import type { FastifyBaseLogger } from "fastify";
import { logUpstream } from "./upstreamLog.js";
import type { LedgerQueryNetwork } from "./horizon.js";
import { resolveHorizonBase } from "./horizon.js";

export type HorizonOrderBookBid = {
  price: string;
  amount: string;
};

export type HorizonOrderBookResponse = {
  bids: HorizonOrderBookBid[];
  asks: HorizonOrderBookBid[];
};

function encodeParam(k: string, v: string): string {
  return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
}

/** Proxies Horizon `GET /order_book` for the SDEX pair (selling credit asset vs buying native XLM). */
export async function fetchOrderBookSellingCreditForNative(params: {
  network: LedgerQueryNetwork;
  assetCode: string;
  assetIssuer: string;
  log?: FastifyBaseLogger;
}): Promise<HorizonOrderBookResponse> {
  const base = resolveHorizonBase(params.network);
  const typ = params.assetCode.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
  const qs = [
    encodeParam("selling_asset_type", typ),
    encodeParam("selling_asset_code", params.assetCode),
    encodeParam("selling_asset_issuer", params.assetIssuer),
    encodeParam("buying_asset_type", "native"),
  ].join("&");
  const url = `${base}/order_book?${qs}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  logUpstream(
    params.log,
    "horizon_order_book",
    { url, status: res.status, bytes: text.length },
    res.ok ? undefined : text,
  );
  if (!res.ok) {
    throw new Error(`Horizon order_book error ${res.status}: ${text.slice(0, 400)}`);
  }
  const body = JSON.parse(text) as { bids?: unknown[]; asks?: unknown[] };
  const bids: HorizonOrderBookBid[] = [];
  for (const r of body.bids ?? []) {
    if (r && typeof r === "object" && "price" in r && "amount" in r) {
      const price = String((r as { price?: unknown }).price ?? "");
      const amount = String((r as { amount?: unknown }).amount ?? "");
      if (price && amount) bids.push({ price, amount });
    }
  }
  const asks: HorizonOrderBookBid[] = [];
  for (const r of body.asks ?? []) {
    if (r && typeof r === "object" && "price" in r && "amount" in r) {
      const price = String((r as { price?: unknown }).price ?? "");
      const amount = String((r as { amount?: unknown }).amount ?? "");
      if (price && amount) asks.push({ price, amount });
    }
  }
  return { bids, asks };
}
