import type { FastifyBaseLogger } from "fastify";
import type { HorizonAccountShape, SorobanScanResult } from "@stellar/core";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Api, Server } from "@stellar/stellar-sdk/rpc";
import type { LedgerQueryNetwork } from "./horizon.js";
import { isUpstreamBodyLogEnabled, logUpstream } from "./upstreamLog.js";

/** Defaults match [Stellar RPC public providers](https://developers.stellar.org/docs/data/apis/rpc/providers). SDF `soroban-testnet.stellar.org` works for testnet; there is no working public `*.stellar.org` mainnet Soroban host in DNS — use Gateway.fm unless `SOROBAN_RPC_URL` overrides. */
const DEFAULT_SOROBAN_RPC: Record<LedgerQueryNetwork, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
};

export function resolveSorobanRpcUrl(network: LedgerQueryNetwork): string {
  const o = process.env.SOROBAN_RPC_URL?.trim();
  if (o) return o.replace(/\/$/, "");
  return DEFAULT_SOROBAN_RPC[network];
}

function parseAllowanceSpenders(): string[] {
  const raw = process.env.SOROBAN_ALLOWANCE_SPENDERS?.trim();
  if (!raw) return [];
  return raw
    .split(/[,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => StrKey.isValidContract(s));
}

function passphraseFor(network: LedgerQueryNetwork): string {
  return network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

function assetLabel(asset: Asset): string {
  return asset.isNative() ? "native:XLM" : `${asset.getCode()}:${asset.getIssuer()}`;
}

function assetsFromHorizon(balances: HorizonAccountShape["balances"] | undefined): Asset[] {
  const out: Asset[] = [Asset.native()];
  const seen = new Set<string>(["native"]);
  for (const b of balances ?? []) {
    if (b.asset_type !== "credit_alphanum4" && b.asset_type !== "credit_alphanum12") continue;
    const code = b.asset_code;
    const iss = b.asset_issuer;
    if (!code || !iss) continue;
    const k = `${code}:${iss}`;
    if (seen.has(k)) continue;
    try {
      out.push(new Asset(code, iss));
      seen.add(k);
    } catch {
      /* invalid asset */
    }
  }
  return out;
}

async function readSacBalance(
  server: Server,
  passphrase: string,
  asset: Asset,
  holderG: string,
): Promise<{ assetLabel: string; sacContractId: string; amount: string; hasEntry: boolean }> {
  const label = assetLabel(asset);
  let sacId: string;
  try {
    sacId = asset.contractId(passphrase);
  } catch {
    return { assetLabel: label, sacContractId: "", amount: "0", hasEntry: false };
  }

  const key = xdr.ScVal.scvVec([
    nativeToScVal("Balance", { type: "symbol" }),
    Address.fromString(holderG).toScVal(),
  ]);

  try {
    const res = await server.getContractData(sacId, key);
    if (res.val.switch() !== xdr.LedgerEntryType.contractData()) {
      return { assetLabel: label, sacContractId: sacId, amount: "0", hasEntry: false };
    }
    const raw = scValToNative(res.val.contractData().val()) as {
      amount?: bigint | string | number;
    };
    const amt = raw.amount;
    const amount =
      amt === undefined ? "0" : typeof amt === "bigint" ? amt.toString() : String(amt);
    return { assetLabel: label, sacContractId: sacId, amount, hasEntry: true };
  } catch {
    return { assetLabel: label, sacContractId: sacId, amount: "0", hasEntry: false };
  }
}

async function readAllowanceAmount(
  server: Server,
  passphrase: string,
  sacId: string,
  holderG: string,
  spenderC: string,
): Promise<string> {
  const c = new Contract(sacId);
  const op = c.call("allowance", Address.fromString(holderG).toScVal(), Address.fromString(spenderC).toScVal());
  const src = new Account(holderG, "9223372036854775807");
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(op)
    .setTimeout(0)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) return "0";
  const ret = sim.result?.retval;
  if (!ret) return "0";
  try {
    const n = scValToNative(ret);
    if (n && typeof n === "object" && "amount" in n) {
      const a = (n as { amount: bigint | number | string }).amount;
      return typeof a === "bigint" ? a.toString() : String(a);
    }
    if (typeof n === "bigint") return n.toString();
    return "0";
  } catch {
    return "0";
  }
}

export async function scanSorobanForAccount(opts: {
  accountId: string;
  horizonAccount: HorizonAccountShape;
  network: LedgerQueryNetwork;
  log?: FastifyBaseLogger;
}): Promise<SorobanScanResult> {
  const { log } = opts;
  const rpcUrl = resolveSorobanRpcUrl(opts.network);
  const passphrase = passphraseFor(opts.network);
  const server = new Server(rpcUrl);
  const spenders = parseAllowanceSpenders();
  const allowanceCheckIncomplete = spenders.length === 0;

  try {
    const health = await server.getHealth();
    logUpstream(log, "soroban_rpc_health", {
      accountId: opts.accountId,
      rpcUrl,
      healthStatus: (health as { status?: string })?.status ?? "ok",
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    logUpstream(log, "soroban_rpc_health_error", { accountId: opts.accountId, rpcUrl, error: err });
    return {
      rpcUrl,
      ok: false,
      errorMessage: err,
      balances: [],
      allowances: [],
      allowanceCheckIncomplete: true,
    };
  }

  const assets = assetsFromHorizon(opts.horizonAccount.balances);
  const balanceRows = await Promise.all(
    assets.map((a) => readSacBalance(server, passphrase, a, opts.accountId)),
  );

  const allowances: SorobanScanResult["allowances"] = [];
  if (!allowanceCheckIncomplete) {
    for (const row of balanceRows) {
      if (!row.sacContractId) continue;
      for (const spender of spenders) {
        const amount = await readAllowanceAmount(server, passphrase, row.sacContractId, opts.accountId, spender);
        allowances.push({ assetLabel: row.assetLabel, spender, amount });
      }
    }
  }

  logUpstream(log, "soroban_scan_done", {
    accountId: opts.accountId,
    rpcUrl,
    ok: true,
    assetsChecked: balanceRows.length,
    allowanceRows: allowances.length,
    allowanceCheckIncomplete,
  });
  if (isUpstreamBodyLogEnabled()) {
    logUpstream(
      log,
      "soroban_scan_body",
      { accountId: opts.accountId, rpcUrl },
      JSON.stringify({ balances: balanceRows, allowances }),
    );
  }

  return {
    rpcUrl,
    ok: true,
    balances: balanceRows,
    allowances,
    allowanceCheckIncomplete,
  };
}
