import type { LpShareRow, SdexOfferRow } from "@stellar/core";
import { Asset, BASE_FEE, Horizon, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import type { UiNetwork } from "./network.js";

const MAX_OPS = 100;

/** Result of building a classic cleanup transaction batch (sign + submit). */
export type ClassicBatchResult = {
  xdr: string;
  opCount: number;
  truncated: boolean;
  totalDiscovered: number;
  /** Shown after success when user may need another pass */
  followUpHint?: string;
};

export function sdkPassphrase(network: UiNetwork): string {
  return network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

export function horizonServer(horizonUrl: string): Horizon.Server {
  return new Horizon.Server(horizonUrl, { allowHttp: horizonUrl.startsWith("http:") });
}

export function horizonAssetRecordToAsset(h: Record<string, unknown>): Asset {
  const t = (typeof h.asset_type === "string" ? h.asset_type : undefined) ?? (typeof h.type === "string" ? h.type : undefined);
  if (t === "native") return Asset.native();
  if (t === "credit_alphanum4" || t === "credit_alphanum12") {
    const code = String(h.asset_code ?? h.code ?? "");
    const issuer = String(h.asset_issuer ?? h.issuer ?? "");
    return new Asset(code, issuer);
  }
  throw new Error(`Cannot map Horizon asset (${t ?? "unknown"}) to SDK Asset for this operation.`);
}

/** Build XDR for up to {@link MAX_OPS} `manage_sell_offer` ops that cancel open offers (amount 0). */
export async function buildCancelSdexOffersXdr(params: {
  horizonUrl: string;
  sourceAccount: string;
  offers: SdexOfferRow[];
  network: UiNetwork;
}): Promise<string> {
  const server = horizonServer(params.horizonUrl);
  const account = await server.loadAccount(params.sourceAccount);
  const slice = params.offers.slice(0, MAX_OPS);
  let b = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: sdkPassphrase(params.network),
  });
  for (const o of slice) {
    b = b.addOperation(
      Operation.manageSellOffer({
        selling: horizonAssetRecordToAsset(o.sellingAsset),
        buying: horizonAssetRecordToAsset(o.buyingAsset),
        amount: "0",
        price: "1",
        offerId: o.id,
      }),
    );
  }
  return b.setTimeout(180).build().toXDR();
}

/** Full withdrawal of pool shares (`minAmount` 0 = maximum slippage — confirm in wallet). */
export async function buildLiquidityPoolWithdrawAllXdr(params: {
  horizonUrl: string;
  sourceAccount: string;
  pool: LpShareRow;
  network: UiNetwork;
}): Promise<string> {
  const server = horizonServer(params.horizonUrl);
  const account = await server.loadAccount(params.sourceAccount);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: sdkPassphrase(params.network),
  })
    .addOperation(
      Operation.liquidityPoolWithdraw({
        liquidityPoolId: params.pool.poolId,
        amount: params.pool.balance,
        minAmountA: "0",
        minAmountB: "0",
      }),
    )
    .setTimeout(180)
    .build();
  return tx.toXDR();
}

export async function submitSignedClassicTx(horizonUrl: string, signedTxXdr: string, network: UiNetwork): Promise<{ hash: string }> {
  const server = horizonServer(horizonUrl);
  const tx = TransactionBuilder.fromXDR(signedTxXdr, sdkPassphrase(network));
  const res = await server.submitTransaction(tx);
  return { hash: res.hash };
}
