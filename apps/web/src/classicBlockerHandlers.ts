import type { BlockerCode, LpShareRow } from "@stellar/core";

import type { UiNetwork } from "./network.js";
import type { ClassicBatchResult } from "./classicClose.js";
import {
  buildCancelOpenOffersBatchXdr,
  buildClaimClaimableBalancesBatchXdr,
  buildClearDataEntriesBatchXdr,
  buildMergeFriendlySignersAndThresholdsBatchXdr,
  buildRemoveEmptyTrustlinesBatchXdr,
  buildWithdrawLiquidityPoolsBatchXdr,
  fetchClaimableBalanceIdsFromApi,
  fetchOpenOffersFromApi,
} from "./classicDemolish.js";
import { buildRevokeSponsorshipBatchXdr } from "./sponsorshipRevoke.js";

export type ClassicSignSubmit = (batch: ClassicBatchResult) => Promise<{ hash: string }>;

export type ClassicBlockerDeps = {
  accountId: string;
  horizonUrl: string;
  network: UiNetwork;
  signSubmit: ClassicSignSubmit;
  lpShares?: LpShareRow[];
};

/** Run the automated classic fix for this `Blocker.code`, or throw. */
export async function runClassicBlockerFix(code: BlockerCode, deps: ClassicBlockerDeps): Promise<string> {
  const { accountId, horizonUrl, network, signSubmit, lpShares } = deps;

  switch (code) {
    case "SPONSORING_OTHER_ACCOUNTS": {
      const batch = await buildRevokeSponsorshipBatchXdr({
        horizonUrl,
        sponsorAccountId: accountId,
        network,
      });
      if (batch.opCount === 0) {
        throw new Error(
          "Horizon returned no sponsored ledger entries. If `num_sponsoring` > 0, try again or use Stellar Lab.",
        );
      }
      const { hash } = await signSubmit(batch);
      return formatBatchSuccess("RevokeSponsorship", batch, hash);
    }
    case "DATA_ENTRIES": {
      const batch = await buildClearDataEntriesBatchXdr({ horizonUrl, sourceAccount: accountId, network });
      const { hash } = await signSubmit(batch);
      return formatBatchSuccess("ManageData (remove)", batch, hash);
    }
    case "OPEN_OFFERS": {
      const offers = await fetchOpenOffersFromApi(accountId, network);
      const batch = await buildCancelOpenOffersBatchXdr({
        horizonUrl,
        sourceAccount: accountId,
        network,
        offers,
      });
      const { hash } = await signSubmit(batch);
      return formatBatchSuccess("Cancel offers", batch, hash);
    }
    case "OPEN_LIQUIDITY_POOL": {
      const batch = await buildWithdrawLiquidityPoolsBatchXdr({
        horizonUrl,
        sourceAccount: accountId,
        network,
        pools: lpShares ?? [],
      });
      const { hash } = await signSubmit(batch);
      return formatBatchSuccess("Liquidity pool withdraw", batch, hash);
    }
    case "TRUSTLINES_OR_ASSET_BALANCES": {
      const batch = await buildRemoveEmptyTrustlinesBatchXdr({
        horizonUrl,
        sourceAccount: accountId,
        network,
      });
      const { hash } = await signSubmit(batch);
      return formatBatchSuccess("ChangeTrust (remove empty)", batch, hash);
    }
    case "MULTISIG_OR_EXTRA_SIGNERS":
    case "NON_DEFAULT_THRESHOLDS": {
      const batch = await buildMergeFriendlySignersAndThresholdsBatchXdr({
        horizonUrl,
        sourceAccount: accountId,
        network,
      });
      const { hash } = await signSubmit(batch);
      return formatBatchSuccess("SetOptions (merge-friendly)", batch, hash);
    }
    case "CLAIMABLE_BALANCES_PENDING": {
      const ids = await fetchClaimableBalanceIdsFromApi(accountId, network);
      const batch = await buildClaimClaimableBalancesBatchXdr({
        horizonUrl,
        sourceAccount: accountId,
        network,
        balanceIds: ids,
      });
      const { hash } = await signSubmit(batch);
      return formatBatchSuccess("Claim claimable balance", batch, hash);
    }
    default:
      throw new Error(`No automated fix for blocker ${code}.`);
  }
}

function formatBatchSuccess(label: string, batch: ClassicBatchResult, hash: string): string {
  let msg = `${label}: submitted ${batch.opCount} operation(s). Tx ${hash.slice(0, 10)}…`;
  if (batch.followUpHint) msg += ` ${batch.followUpHint}`;
  return msg;
}

export const CLASSIC_BLOCKER_CODES: ReadonlySet<BlockerCode> = new Set([
  "SPONSORING_OTHER_ACCOUNTS",
  "DATA_ENTRIES",
  "OPEN_OFFERS",
  "OPEN_LIQUIDITY_POOL",
  "TRUSTLINES_OR_ASSET_BALANCES",
  "MULTISIG_OR_EXTRA_SIGNERS",
  "NON_DEFAULT_THRESHOLDS",
  "CLAIMABLE_BALANCES_PENDING",
]);

export function classicBlockerButtonLabel(code: BlockerCode): string {
  switch (code) {
    case "SPONSORING_OTHER_ACCOUNTS":
      return "Revoke sponsored reserves (sign)";
    case "DATA_ENTRIES":
      return "Remove data entries (sign)";
    case "OPEN_OFFERS":
      return "Cancel open offers (sign)";
    case "OPEN_LIQUIDITY_POOL":
      return "Withdraw pool shares (sign)";
    case "TRUSTLINES_OR_ASSET_BALANCES":
      return "Remove empty trustlines only (sign)";
    case "MULTISIG_OR_EXTRA_SIGNERS":
      return "Remove extra signers (sign)";
    case "NON_DEFAULT_THRESHOLDS":
      return "Set merge-friendly thresholds (sign)";
    case "CLAIMABLE_BALANCES_PENDING":
      return "Claim inbound balances (sign)";
    default:
      return "Sign & resolve (soon)";
  }
}

export function classicBlockerButtonTitle(
  code: BlockerCode,
  ready: boolean,
  walletMismatch: boolean,
  hasHorizon: boolean,
): string {
  if (!ready) {
    if (!hasHorizon) return "No Horizon URL in health response";
    if (walletMismatch) return "Connected wallet must match the source account field";
    return "Connect wallet first";
  }
  switch (code) {
    case "TRUSTLINES_OR_ASSET_BALANCES":
      return "Removes zero-balance lines only. Use the Trustlines section (above Step 3) to sell, payout, or clear balances first.";
    case "OPEN_LIQUIDITY_POOL":
      return "Withdraws all LP shares with min amounts 0 (high slippage risk — confirm in wallet)";
    case "MULTISIG_OR_EXTRA_SIGNERS":
      return "Phase 1: removes up to 100 extra ed25519 signers per tx (re-run until clear). Phase 2: same button then sets merge-friendly thresholds.";
    case "NON_DEFAULT_THRESHOLDS":
      return "Sets master weight 1 and low/med/high thresholds to merge-friendly values (run after extra signers are gone).";
    default:
      return "Build transaction, sign in wallet, submit to Horizon";
  }
}
