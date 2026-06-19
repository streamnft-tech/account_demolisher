import Fastify from "fastify";
import cors from "@fastify/cors";
import { buildHealthReport, extractLiquidityPoolSharesFromHorizonBalances, isValidClassicAddress, type HorizonAccountShape } from "@stellar/core";
import {
  fetchAccountFromHorizon,
  getHorizonOverride,
  parseNetworkQuery,
  resolveHorizonBase,
  type LedgerQueryNetwork,
} from "./horizon.js";
import { fetchSdexOffersForSeller } from "./fetchClassicPositions.js";
import { fetchClaimableBalanceIdsForClaimant } from "./fetchClaimableBalances.js";
import { fetchOrderBookSellingCreditForNative } from "./fetchOrderBook.js";
import { fetchSponsoredEntriesForSponsor } from "./fetchSponsoredEntries.js";
import { scanDefiProtocols } from "./defiScan.js";
import { resolveSorobanRpcUrl, scanSorobanForAccount } from "./sorobanScan.js";
import { buildSoroswapSellCreditToNativeXdr, soroswapBearerConfigured } from "./soroswapClient.js";
import { getLiveStatsSnapshot, recordLiveStatsEvent, type LiveStatsEventInput } from "./liveStats.js";

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

app.get("/api/stats/live", async (_request, reply) => {
  try {
    return reply.send(await getLiveStatsSnapshot());
  } catch (error) {
    return reply.status(500).send({
      error: "STATS_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Unable to load live stats.",
    });
  }
});

app.post("/api/stats/live/event", async (request, reply) => {
  const body = request.body as Partial<LiveStatsEventInput> | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const kind = body?.kind;
  const network = body?.network;
  const recoveredXlm = body?.recoveredXlm;

  if (!id) {
    return reply.status(400).send({ error: "INVALID_EVENT", message: "Event id is required." });
  }
  if (kind !== "cleanup" && kind !== "close") {
    return reply.status(400).send({ error: "INVALID_EVENT", message: "Event kind must be cleanup or close." });
  }
  if (network !== "testnet" && network !== "mainnet") {
    return reply.status(400).send({ error: "INVALID_EVENT", message: "Event network must be testnet or mainnet." });
  }
  if (recoveredXlm !== undefined && (!Number.isFinite(Number(recoveredXlm)) || Number(recoveredXlm) < 0)) {
    return reply.status(400).send({ error: "INVALID_EVENT", message: "recoveredXlm must be a non-negative number." });
  }

  try {
    const snapshot = await recordLiveStatsEvent({
      id,
      kind,
      network,
      recoveredXlm,
    });
    return reply.send(snapshot);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      error: "STATS_WRITE_FAILED",
      message: error instanceof Error ? error.message : "Unable to record live stats event.",
    });
  }
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
    const account = await fetchAccountFromHorizon(id, network, request.log);

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

    const [sdexOffers, soroban, defiProtocols, claimableIdsResult, sponsoredEntries] = await Promise.all([
      fetchSdexOffersForSeller(id, network, request.log),
      scanSorobanForAccount({ accountId: id, horizonAccount: account, network, log: request.log }),
      scanDefiProtocols({ accountId: id, network, sorobanRpcUrl }),
      fetchClaimableBalanceIdsForClaimant(horizonUrl, id, request.log)
        .then((ids): { ok: true; ids: string[] } => ({ ok: true, ids }))
        .catch((err: unknown): { ok: false } => {
          request.log.warn({ err }, "claimable_balances scan failed");
          return { ok: false };
        }),
      fetchSponsoredEntriesForSponsor(id, network, request.log),
    ]);
    const inboundClaimableBalanceCount = claimableIdsResult.ok ? claimableIdsResult.ids.length : undefined;
    const lpShares = extractLiquidityPoolSharesFromHorizonBalances(
      account.balances as Array<Record<string, unknown>> | undefined,
    );
    const offersCount = sdexOffers.length;

    const report = buildHealthReport({
      accountId: id,
      ledgerNetwork,
      horizonUrl,
      sorobanRpcUrl,
      horizonAccount: account,
      offersCount,
      soroban,
      inboundClaimableBalanceCount,
      sponsoredEntries,
      openPositions: {
        sdexOffers,
        liquidityPoolShares: lpShares,
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

app.get("/api/soroswap/status", async () => ({ configured: soroswapBearerConfigured() }));

app.post("/api/soroswap/swap-xdr", async (request, reply) => {
  const network = parseNetworkQuery((request.query as { network?: string }).network);
  const body = request.body as {
    sourceAccount?: string;
    assetCode?: string;
    assetIssuer?: string;
    sellAmount?: string;
    slippageBps?: number;
  };
  const sourceAccount = typeof body.sourceAccount === "string" ? body.sourceAccount.trim() : "";
  const assetCode = typeof body.assetCode === "string" ? body.assetCode.trim() : "";
  const assetIssuer = typeof body.assetIssuer === "string" ? body.assetIssuer.trim() : "";
  const sellAmount = typeof body.sellAmount === "string" ? body.sellAmount.trim() : "";
  const slippageBps = typeof body.slippageBps === "number" && Number.isFinite(body.slippageBps) ? body.slippageBps : 100;

  if (!isValidClassicAddress(sourceAccount)) {
    return reply.status(400).send({ error: "INVALID_ADDRESS", message: "sourceAccount must be a valid classic G-address." });
  }
  if (!assetCode || assetCode.length > 12) {
    return reply.status(400).send({ error: "INVALID_ASSET", message: "assetCode is required (max 12 chars)." });
  }
  if (!isValidClassicAddress(assetIssuer)) {
    return reply.status(400).send({ error: "INVALID_ISSUER", message: "assetIssuer must be a valid classic G-address." });
  }
  if (!sellAmount) {
    return reply.status(400).send({ error: "INVALID_AMOUNT", message: "sellAmount is required." });
  }

  if (!soroswapBearerConfigured()) {
    return reply.status(503).send({
      error: "SOROSWAP_NOT_CONFIGURED",
      message: "Set SOROSWAP_BEARER_TOKEN on the API (JWT from https://api.soroswap.finance/docs) to build Soroswap routes.",
    });
  }

  try {
    const { xdr, quote } = await buildSoroswapSellCreditToNativeXdr({
      network,
      sourceAccount,
      assetCode,
      assetIssuer,
      sellAmount,
      slippageBps,
      log: request.log,
    });
    return reply.send({ xdr, quote });
  } catch (e) {
    request.log.error(e);
    return reply.status(502).send({
      error: "SOROSWAP_UPSTREAM",
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
