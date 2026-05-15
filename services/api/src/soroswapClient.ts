import type { FastifyBaseLogger } from "fastify";
import { Asset, Networks } from "@stellar/stellar-sdk";

import type { LedgerQueryNetwork } from "./horizon.js";
import { logUpstream } from "./upstreamLog.js";

const DEFAULT_BASE = "https://api.soroswap.finance";

export function soroswapBearerConfigured(): boolean {
  return Boolean(process.env.SOROSWAP_BEARER_TOKEN?.trim());
}

function apiBase(): string {
  return (process.env.SOROSWAP_API_BASE?.trim() || DEFAULT_BASE).replace(/\/$/, "");
}

function bearerHeaders(): Record<string, string> {
  const token = process.env.SOROSWAP_BEARER_TOKEN?.trim();
  if (!token) {
    throw new Error("SOROSWAP_BEARER_TOKEN is not set (JWT from Soroswap API login).");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function passphraseFor(network: LedgerQueryNetwork): string {
  return network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

/** Horizon-style decimal amount (e.g. "12.34") to 7-decimal stroops string for Soroswap `amount`. */
export function horizonAmountToStroops(amount: string): string {
  const t = amount.trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) throw new Error("Amount must be a non-negative decimal string.");
  const normalized = t.startsWith(".") ? `0${t}` : t;
  const [wholeRaw, fracRaw = ""] = normalized.split(".");
  const whole = BigInt(wholeRaw === "" ? "0" : wholeRaw);
  const fracDigits = (fracRaw.replace(/\D/g, "") + "0000000").slice(0, 7);
  return (whole * 10_000_000n + BigInt(fracDigits)).toString();
}

/**
 * Quote + build unsigned swap XDR (classic credit asset → native) via Soroswap aggregator API.
 * Requires `SOROSWAP_BEARER_TOKEN` (see https://api.soroswap.finance/docs).
 */
export async function buildSoroswapSellCreditToNativeXdr(params: {
  network: LedgerQueryNetwork;
  sourceAccount: string;
  assetCode: string;
  assetIssuer: string;
  /** Full Horizon balance string */
  sellAmount: string;
  slippageBps: number;
  log?: FastifyBaseLogger;
}): Promise<{ xdr: string; quote: unknown }> {
  const passphrase = passphraseFor(params.network);
  const selling = new Asset(params.assetCode, params.assetIssuer);
  const assetIn = selling.contractId(passphrase);
  const assetOut = Asset.native().contractId(passphrase);
  const amount = horizonAmountToStroops(params.sellAmount);
  const bps = Math.min(5000, Math.max(1, Math.floor(params.slippageBps)));
  const net = params.network === "mainnet" ? "mainnet" : "testnet";
  const q = new URLSearchParams({ network: net });
  const base = apiBase();
  const headers = bearerHeaders();

  const protocols = params.network === "mainnet" ? ["soroswap", "aqua", "phoenix"] : ["soroswap", "aqua"];
  const quoteRes = await fetch(`${base}/quote?${q}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      assetIn,
      assetOut,
      amount,
      tradeType: "EXACT_IN",
      slippageBps: String(bps),
      protocols,
      parts: 7,
      maxHops: 3,
    }),
  });
  const quoteText = await quoteRes.text();
  if (!quoteRes.ok) {
    logUpstream(params.log, "soroswap_quote_error", { status: quoteRes.status }, quoteText);
    throw new Error(`Soroswap quote failed: HTTP ${quoteRes.status} — ${quoteText.slice(0, 280)}`);
  }
  let quoteJson: unknown;
  try {
    quoteJson = JSON.parse(quoteText) as unknown;
  } catch {
    throw new Error("Soroswap quote returned invalid JSON.");
  }

  const buildRes = await fetch(`${base}/quote/build?${q}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      quote: quoteJson,
      from: params.sourceAccount,
      to: params.sourceAccount,
    }),
  });
  const buildText = await buildRes.text();
  if (!buildRes.ok) {
    logUpstream(params.log, "soroswap_build_error", { status: buildRes.status }, buildText);
    throw new Error(`Soroswap build failed: HTTP ${buildRes.status} — ${buildText.slice(0, 280)}`);
  }
  const buildJson = JSON.parse(buildText) as { xdr?: string; action?: string; actionData?: { xdr?: string } };
  const xdr =
    typeof buildJson.xdr === "string"
      ? buildJson.xdr
      : buildJson.action === "SIGN_USER_TRANSACTION" && typeof buildJson.actionData?.xdr === "string"
        ? buildJson.actionData.xdr
        : "";
  if (!xdr) {
    throw new Error("Soroswap build response did not include transaction XDR.");
  }
  return { xdr, quote: quoteJson };
}
