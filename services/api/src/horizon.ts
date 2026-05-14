import type { FastifyBaseLogger } from "fastify";
import type { HorizonAccountShape } from "@stellar/core";
import { logUpstream } from "./upstreamLog.js";

/** User-facing / query-param network (maps to public Horizon URLs). */
export type LedgerQueryNetwork = "testnet" | "mainnet";

const PUBLIC_HORIZON = "https://horizon.stellar.org";
const TESTNET_HORIZON = "https://horizon-testnet.stellar.org";

/** When `HORIZON_URL` is set, every request uses it (custom / single-network deploy). */
export function getHorizonOverride(): string | null {
  const u = process.env.HORIZON_URL?.trim();
  if (!u) return null;
  return u.replace(/\/$/, "");
}

export function resolveHorizonBase(network: LedgerQueryNetwork): string {
  const override = getHorizonOverride();
  if (override) return override;
  return network === "mainnet" ? PUBLIC_HORIZON : TESTNET_HORIZON;
}

export function parseNetworkQuery(raw: unknown): LedgerQueryNetwork {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "mainnet" || s === "public") return "mainnet";
  return "testnet";
}

export async function fetchAccountFromHorizon(
  accountId: string,
  network: LedgerQueryNetwork,
  log?: FastifyBaseLogger,
): Promise<HorizonAccountShape | null> {
  const base = resolveHorizonBase(network);
  const url = `${base}/accounts/${encodeURIComponent(accountId)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  logUpstream(log, "horizon_account", { accountId, url, status: res.status, bytes: text.length }, res.ok ? undefined : text);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Horizon accounts error ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text) as HorizonAccountShape;
  } catch {
    throw new Error(`Horizon accounts: invalid JSON from ${url} (${text.length} bytes)`);
  }
}

/** Returns true if the account has at least one open offer (seller = account). */
export async function hasOpenOffers(
  accountId: string,
  network: LedgerQueryNetwork,
  log?: FastifyBaseLogger,
): Promise<boolean> {
  const base = resolveHorizonBase(network);
  const url = `${base}/offers?seller=${encodeURIComponent(accountId)}&limit=1&order=desc`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  logUpstream(log, "horizon_offers_probe", { accountId, url, status: res.status, bytes: text.length }, res.ok ? undefined : text);
  if (!res.ok) {
    throw new Error(`Horizon offers error ${res.status}: ${text}`);
  }
  let body: { _embedded?: { records?: unknown[] } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`Horizon offers probe: invalid JSON from ${url}`);
  }
  const n = body._embedded?.records?.length ?? 0;
  return n > 0;
}
