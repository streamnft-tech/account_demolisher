import Fastify from "fastify";
import cors from "@fastify/cors";
import { buildHealthReport, isValidClassicAddress, type HorizonAccountShape } from "@stellar/core";
import {
  fetchAccountFromHorizon,
  getHorizonOverride,
  hasOpenOffers,
  parseNetworkQuery,
  resolveHorizonBase,
  type LedgerQueryNetwork,
} from "./horizon.js";
import { fetchSdexOffersForSeller } from "./fetchClassicPositions.js";
import { fetchClaimableBalanceIdsForClaimant } from "./fetchClaimableBalances.js";
import { fetchOrderBookSellingCreditForNative } from "./fetchOrderBook.js";
import { scanDefiProtocols } from "./defiScan.js";
import { resolveSorobanRpcUrl, scanSorobanForAccount } from "./sorobanScan.js";

/** Avoids URIError from `decodeURIComponent` on malformed `%` escapes (would otherwise yield HTTP 500). */
function decodeAccountIdParam(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
});

function ledgerNetworkLabel(network: LedgerQueryNetwork): "testnet" | "mainnet" | "custom" {
  return getHorizonOverride() ? "custom" : network;
}

app.get("/health", async () => {
  const override = getHorizonOverride();
  return {
    ok: true,
    horizonMode: override ? "custom_env" : "per_request",
    horizonOverride: override,
    sorobanRpcMode: process.env.SOROBAN_RPC_URL?.trim() ? "custom_env" : "per_request",
    sorobanRpcOverride: process.env.SOROBAN_RPC_URL?.trim() || null,
    /** Effective URL for each mode (when not overridden, public SDF Horizons) */
    urls: override
      ? { testnet: override, mainnet: override, note: "HORIZON_URL overrides both" }
      : {
          testnet: "https://horizon-testnet.stellar.org",
          mainnet: "https://horizon.stellar.org",
        },
    sorobanUrls: process.env.SOROBAN_RPC_URL?.trim()
      ? { testnet: resolveSorobanRpcUrl("testnet"), mainnet: resolveSorobanRpcUrl("mainnet"), note: "SOROBAN_RPC_URL overrides both" }
      : {
          testnet: "https://soroban-testnet.stellar.org",
          mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
        },
  };
});

app.get("/api/account/:accountId/horizon", async (request, reply) => {
  const { accountId } = request.params as { accountId: string };
  const id = decodeAccountIdParam(accountId);
  const network: LedgerQueryNetwork = parseNetworkQuery((request.query as { network?: string }).network);
  const horizonUrl = resolveHorizonBase(network);
  const sorobanRpcUrl = resolveSorobanRpcUrl(network);
  const ledgerNetwork = ledgerNetworkLabel(network);

  if (!isValidClassicAddress(id)) {
    return reply.status(400).send({ error: "INVALID_ADDRESS", message: "Not a valid classic G-address." });
  }

  try {
    const account = await fetchAccountFromHorizon(id, network, request.log);
    return reply.send({
      ledgerNetwork,
      horizonUrl,
      sorobanRpcUrl,
      account,
    } satisfies {
      ledgerNetwork: "testnet" | "mainnet" | "custom";
      horizonUrl: string;
      sorobanRpcUrl: string;
      account: HorizonAccountShape | null;
    });
  } catch (e) {
    request.log.error(e);
    return reply.status(502).send({
      error: "HORIZON_UPSTREAM",
      message: e instanceof Error ? e.message : "Unknown error",
    });
  }
});

app.post("/api/account/:accountId/soroban-scan", async (request, reply) => {
  const { accountId } = request.params as { accountId: string };
  const id = decodeAccountIdParam(accountId);
  const network: LedgerQueryNetwork = parseNetworkQuery((request.query as { network?: string }).network);

  if (!isValidClassicAddress(id)) {
    return reply.status(400).send({ error: "INVALID_ADDRESS", message: "Not a valid classic G-address." });
  }

  const body = request.body as { horizonAccount?: HorizonAccountShape };
  if (!body?.horizonAccount || typeof body.horizonAccount.id !== "string") {
    return reply.status(400).send({ error: "MISSING_BODY", message: "JSON body must include horizonAccount." });
  }
  if (body.horizonAccount.id !== id) {
    return reply.status(400).send({
      error: "ACCOUNT_MISMATCH",
      message: "horizonAccount.id must match the account id in the URL.",
    });
  }

  try {
    const sorobanRpcUrl = resolveSorobanRpcUrl(network);
    const [soroban, defiProtocols] = await Promise.all([
      scanSorobanForAccount({
        accountId: id,
        horizonAccount: body.horizonAccount,
        network,
        log: request.log,
      }),
      scanDefiProtocols({ accountId: id, network, sorobanRpcUrl }),
    ]);
    return reply.send({ soroban, defiProtocols });
  } catch (e) {
    request.log.error(e);
    return reply.status(502).send({
      error: "SOROBAN_UPSTREAM",
      message: e instanceof Error ? e.message : "Unknown error",
    });
  }
});

app.get("/api/account/:accountId/offers", async (request, reply) => {
  const { accountId } = request.params as { accountId: string };
  const id = decodeAccountIdParam(accountId);
  const network: LedgerQueryNetwork = parseNetworkQuery((request.query as { network?: string }).network);

  if (!isValidClassicAddress(id)) {
    return reply.status(400).send({ error: "INVALID_ADDRESS", message: "Not a valid classic G-address." });
  }

  try {
    const offers = await fetchSdexOffersForSeller(id, network, request.log);
    return reply.send({ offers });
  } catch (e) {
    request.log.error(e);
    return reply.status(502).send({
      error: "HORIZON_UPSTREAM",
      message: e instanceof Error ? e.message : "Unknown error",
    });
  }
});

app.get("/api/account/:accountId/claimable-balances", async (request, reply) => {
  const { accountId } = request.params as { accountId: string };
  const id = decodeAccountIdParam(accountId);
  const network: LedgerQueryNetwork = parseNetworkQuery((request.query as { network?: string }).network);
  const horizonUrl = resolveHorizonBase(network);

  if (!isValidClassicAddress(id)) {
    return reply.status(400).send({ error: "INVALID_ADDRESS", message: "Not a valid classic G-address." });
  }

  try {
    const ids = await fetchClaimableBalanceIdsForClaimant(horizonUrl, id, request.log);
    return reply.send({
      claimableBalances: ids.map((balanceId) => ({ id: balanceId })),
    });
  } catch (e) {
    request.log.error(e);
    return reply.status(502).send({
      error: "HORIZON_UPSTREAM",
      message: e instanceof Error ? e.message : "Unknown error",
    });
  }
});

app.get("/api/order-book", async (request, reply) => {
  const q = request.query as {
    network?: string;
    asset_code?: string;
    asset_issuer?: string;
  };
  const network: LedgerQueryNetwork = parseNetworkQuery(q.network);
  const code = typeof q.asset_code === "string" ? q.asset_code.trim() : "";
  const issuer = typeof q.asset_issuer === "string" ? q.asset_issuer.trim() : "";

  if (!code || code.length > 12 || !/^[a-zA-Z0-9]+$/.test(code)) {
    return reply.status(400).send({ error: "INVALID_ASSET_CODE", message: "asset_code must be 1–12 alphanumeric characters." });
  }
  if (!isValidClassicAddress(issuer)) {
    return reply.status(400).send({ error: "INVALID_ISSUER", message: "asset_issuer must be a valid classic G-address." });
  }

  try {
    const book = await fetchOrderBookSellingCreditForNative({
      network,
      assetCode: code,
      assetIssuer: issuer,
      log: request.log,
    });
    return reply.send({
      ledgerNetwork: ledgerNetworkLabel(network),
      horizonUrl: resolveHorizonBase(network),
      selling: { type: "credit", code, issuer },
      buying: { type: "native" },
      bids: book.bids,
      asks: book.asks,
    });
  } catch (e) {
    request.log.error(e);
    return reply.status(502).send({
      error: "HORIZON_UPSTREAM",
      message: e instanceof Error ? e.message : "Unknown error",
    });
  }
});

app.get("/api/account/:accountId/health", async (request, reply) => {
  const { accountId } = request.params as { accountId: string };
  const id = decodeAccountIdParam(accountId);
  const network: LedgerQueryNetwork = parseNetworkQuery((request.query as { network?: string }).network);
  const horizonUrl = resolveHorizonBase(network);
  const sorobanRpcUrl = resolveSorobanRpcUrl(network);
  const ledgerNetwork = ledgerNetworkLabel(network);

  if (!isValidClassicAddress(id)) {
    const report = buildHealthReport({
      accountId: id,
      ledgerNetwork,
      horizonUrl,
      sorobanRpcUrl,
      horizonAccount: null,
      offersCount: 0,
      soroban: {
        rpcUrl: sorobanRpcUrl,
        ok: true,
        balances: [],
        allowances: [],
        allowanceCheckIncomplete: true,
      },
    });
    return reply.send(report);
  }

  try {
    const [account, offersExist] = await Promise.all([
      fetchAccountFromHorizon(id, network, request.log),
      hasOpenOffers(id, network, request.log),
    ]);
    const offersCount = offersExist ? 1 : 0;

    if (!account) {
      const report = buildHealthReport({
        accountId: id,
        ledgerNetwork,
        horizonUrl,
        sorobanRpcUrl,
        horizonAccount: null,
        offersCount: 0,
        soroban: {
          rpcUrl: sorobanRpcUrl,
          ok: true,
          balances: [],
          allowances: [],
          allowanceCheckIncomplete: true,
        },
      });
      return reply.send(report);
    }

    const [soroban, defiProtocols, claimableIdsResult] = await Promise.all([
      scanSorobanForAccount({ accountId: id, horizonAccount: account, network, log: request.log }),
      scanDefiProtocols({ accountId: id, network, sorobanRpcUrl }),
      fetchClaimableBalanceIdsForClaimant(horizonUrl, id, request.log)
        .then((ids): { ok: true; ids: string[] } => ({ ok: true, ids }))
        .catch((err: unknown): { ok: false } => {
          request.log.warn({ err }, "claimable_balances scan failed");
          return { ok: false };
        }),
    ]);
    const inboundClaimableBalanceCount = claimableIdsResult.ok ? claimableIdsResult.ids.length : undefined;

    const report = buildHealthReport({
      accountId: id,
      ledgerNetwork,
      horizonUrl,
      sorobanRpcUrl,
      horizonAccount: account,
      offersCount,
      soroban,
      inboundClaimableBalanceCount,
      openPositions: {
        sdexOffers: [],
        liquidityPoolShares: [],
        defiProtocols,
      },
    });
    return reply.send(report);
  } catch (e) {
    request.log.error(e);
    return reply.status(502).send({
      error: "HORIZON_UPSTREAM",
      message: e instanceof Error ? e.message : "Unknown error",
    });
  }
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

await app.listen({ port, host });
const override = getHorizonOverride();
console.log(
  `API listening on http://${host}:${port} (Horizon: ${override ?? "per-request testnet|mainnet — see ?network="})`,
);
