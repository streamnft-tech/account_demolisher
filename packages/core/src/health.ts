/**
 * Health report + full checklist (classic + Soroban surface).
 * Pure logic — network I/O lives in the API.
 */

import type { LpShareRow, OpenPositionsSnapshot, SdexOfferRow } from "./positions.js";
import { defiProtocolSurfacesForNetwork, extractLiquidityPoolSharesFromHorizonBalances } from "./positions.js";

export type StellarNetwork = "PUBLIC" | "TESTNET" | "FUTURENET";

export type BlockerCode =
  | "INVALID_ACCOUNT_ID"
  | "ACCOUNT_NOT_FOUND"
  | "SPONSORING_OTHER_ACCOUNTS"
  | "MULTISIG_OR_EXTRA_SIGNERS"
  | "NON_DEFAULT_THRESHOLDS"
  | "TRUSTLINES_OR_ASSET_BALANCES"
  | "OPEN_OFFERS"
  | "OPEN_LIQUIDITY_POOL"
  | "DATA_ENTRIES"
  | "LOW_RESERVE"
  | "NATIVE_PAYOUT_ON_MERGE"
  | "SOROBAN_RPC"
  | "SOROBAN_TOKEN_BALANCE"
  | "SOROBAN_ALLOWANCE"
  | "CLAIMABLE_BALANCES_PENDING"
  | "DEFI_POSITIONS_UNKNOWN"
  | "DEFI_POSITIONS_OPEN";

export interface Blocker {
  code: BlockerCode;
  order: number;
  kind: "blocking" | "informational";
  title: string;
  description: string;
}

/** One row in the UI checklist */
export type ChecklistStatus = "pass" | "fail" | "unknown" | "skipped";

export interface HealthChecklistItem {
  id: string;
  label: string;
  /** Extra context shown under the label */
  detail?: string;
  status: ChecklistStatus;
  /** If true, a `fail` on this row blocks demolish */
  blocksDemolish: boolean;
}

export interface SorobanScanResult {
  rpcUrl: string;
  /** false if RPC threw / unreachable */
  ok: boolean;
  errorMessage?: string;
  balances: Array<{ assetLabel: string; sacContractId: string; amount: string; hasEntry: boolean }>;
  allowances: Array<{ assetLabel: string; spender: string; amount: string }>;
  /** true when no spender list configured — allowances not fully verified */
  allowanceCheckIncomplete: boolean;
}

export interface ClassicAccountSummary {
  sponsorships: {
    sponsoringCount: number;
    entries?: SponsoredLedgerEntry[];
  };
  signers: {
    accountId: string;
    masterWeight: number;
    extra: Array<{ key: string; weight: number }>;
  };
  thresholds: {
    low: number;
    medium: number;
    high: number;
    mergeFriendly: boolean;
  };
}

export interface SponsoredLedgerEntry {
  type:
    | "claimable_balance"
    | "offer"
    | "liquidity_pool"
    | "trustline"
    | "signer"
    | "account";
  id: string;
  label: string;
  accountId?: string;
  detail?: string;
}

export interface HealthReport {
  accountId: string;
  sequence?: string;
  blockers: Blocker[];
  canDemolish: boolean;
  summary: string;
  ledgerNetwork?: "testnet" | "mainnet" | "custom";
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  nativeBalanceXlm?: number;
  checklist: HealthChecklistItem[];
  /** Safe derived classic-account details for user-facing review rows. */
  classicAccount?: ClassicAccountSummary;
  /** When present, SDEX offers + LP rows + protocol metadata for merge prep (from API scan). */
  openPositions?: OpenPositionsSnapshot;
}

const G_ADDRESS = /^G[A-Z2-7]{55}$/;

export function isValidClassicAddress(accountId: string): boolean {
  return G_ADDRESS.test(accountId.trim());
}

export interface HorizonAccountShape {
  id: string;
  sequence?: string;
  balances?: Array<{ asset_type?: string; balance?: string; asset_code?: string; asset_issuer?: string }>;
  signers?: Array<{ key: string; weight: number }>;
  thresholds?: { low_threshold: number; med_threshold: number; high_threshold: number };
  data?: Record<string, string>;
  num_sponsoring?: number;
  subentry_count?: number;
}

const BASE_RESERVE_XLM = 0.5;

function parseNum(x: string | undefined): number {
  if (x === undefined) return 0;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

export interface BuildHealthReportInput {
  accountId: string;
  ledgerNetwork: "testnet" | "mainnet" | "custom";
  horizonUrl: string;
  sorobanRpcUrl: string;
  horizonAccount: HorizonAccountShape | null;
  offersCount: number;
  soroban: SorobanScanResult | null;
  /** Inbound claimable balances where this account is a claimant (Horizon); optional for health reports built without this scan. */
  inboundClaimableBalanceCount?: number;
  /** Sponsored ledger entries where this account is the sponsor. */
  sponsoredEntries?: SponsoredLedgerEntry[];
  /** Full classic offer list + defi protocol surface; LP shares may be omitted and derived from Horizon balances. */
  openPositions?: OpenPositionsSnapshot | null;
}

function effectiveSdexOfferRows(input: BuildHealthReportInput): SdexOfferRow[] {
  return input.openPositions?.sdexOffers ?? [];
}

function effectiveOfferCount(input: BuildHealthReportInput): number {
  const n = effectiveSdexOfferRows(input).length;
  if (n > 0) return n;
  return input.offersCount;
}

function effectiveLpRows(input: BuildHealthReportInput): LpShareRow[] {
  if (input.openPositions?.liquidityPoolShares && input.openPositions.liquidityPoolShares.length > 0) {
    return input.openPositions.liquidityPoolShares;
  }
  return extractLiquidityPoolSharesFromHorizonBalances(
    input.horizonAccount?.balances as Array<Record<string, unknown>> | undefined,
  );
}

/**
 * Build full health report + checklist for UI.
 */
export function buildHealthReport(input: BuildHealthReportInput): HealthReport {
  const id = input.accountId.trim();
  const checklist: HealthChecklistItem[] = [];

  const push = (row: HealthChecklistItem) => {
    checklist.push(row);
  };

  if (!isValidClassicAddress(id)) {
    push({
      id: "address_format",
      label: "Valid classic address (G…)",
      status: "fail",
      detail: "Must be 56-character base32 public key.",
      blocksDemolish: true,
    });
    fillRemainingUnknown(checklist);
    return finalizeReport({
      accountId: id,
      blockers: [mkBlocker("INVALID_ACCOUNT_ID", 0, "blocking", "Invalid Stellar address", "Enter a valid classic account (G…, 56 characters).")],
      summary: "Invalid address format.",
      checklist,
      input,
      nativeBalance: undefined,
      openPositions: undefined,
    });
  }

  push({
    id: "address_format",
    label: "Valid classic address (G…)",
    status: "pass",
    blocksDemolish: true,
  });

  if (!input.horizonAccount) {
    push({
      id: "account_exists",
      label: "Account exists on Horizon",
      status: "fail",
      detail: "404 — wrong network or account not funded.",
      blocksDemolish: true,
    });
    fillRemainingUnknown(checklist);
    return finalizeReport({
      accountId: id,
      blockers: [
        mkBlocker(
          "ACCOUNT_NOT_FOUND",
          0,
          "blocking",
          "Account not found",
          "Horizon returned 404 — the account does not exist on this network, or the wrong Horizon URL is configured.",
        ),
      ],
      summary: "Account not found on this network.",
      checklist,
      input,
      nativeBalance: undefined,
      openPositions: undefined,
    });
  }

  const account = input.horizonAccount;
  push({
    id: "account_exists",
    label: "Account exists on Horizon",
    status: "pass",
    detail: `Sequence ${account.sequence ?? "?"}`,
    blocksDemolish: true,
  });

  const numSponsoring = account.num_sponsoring ?? 0;
  push({
    id: "classic_sponsorship",
    label: "Not sponsoring other accounts' reserves",
    status: numSponsoring > 0 ? "fail" : "pass",
    detail: numSponsoring > 0 ? `${numSponsoring} sponsored reserve unit(s)` : undefined,
    blocksDemolish: true,
  });

  const signers = account.signers ?? [];
  const extraSigners = signers.filter((s) => s.key !== account.id);
  push({
    id: "classic_extra_signers",
    label: "No extra account signers (merge-friendly)",
    status: extraSigners.length > 0 ? "fail" : "pass",
    detail: extraSigners.length > 0 ? `${extraSigners.length} signer(s) beyond the account itself` : undefined,
    blocksDemolish: true,
  });

  const th = account.thresholds ?? { low_threshold: 1, med_threshold: 0, high_threshold: 0 };
  const thresholdsOk = th.low_threshold <= 1 && th.med_threshold === 0 && th.high_threshold === 0;
  push({
    id: "classic_thresholds",
    label: "Signature thresholds are merge-friendly",
    status: thresholdsOk ? "pass" : "fail",
    detail: `low=${th.low_threshold} med=${th.med_threshold} high=${th.high_threshold}`,
    blocksDemolish: true,
  });

  const balances = account.balances ?? [];
  const hasTrustlines = balances.some((b) => b.asset_type !== "native");
  push({
    id: "classic_trustlines",
    label: "No classic trustlines / non-native balances",
    status: hasTrustlines ? "fail" : "pass",
    detail: hasTrustlines ? "Remove trustlines after zeroing balances" : undefined,
    blocksDemolish: true,
  });

  const offerCount = effectiveOfferCount(input);
  const offerRows = effectiveSdexOfferRows(input);
  push({
    id: "classic_open_offers",
    label: "No open classic (SDEX) offers",
    status: offerCount > 0 ? "fail" : "pass",
    detail:
      offerCount > 0
        ? offerRows.length > 0
          ? `${offerCount} open offer(s): ${offerRows
              .slice(0, 6)
              .map((o) => `#${o.id}`)
              .join(", ")}${offerRows.length > 6 ? "…" : ""}`
          : `${offerCount} open offer(s) — run health check from the app for offer IDs.`
        : undefined,
    blocksDemolish: true,
  });

  const lpRowsAll = effectiveLpRows(input);
  const lpPositive = lpRowsAll.filter((r) => parseNum(r.balance) > 1e-7);
  push({
    id: "classic_amm_lp_shares",
    label: "No classic AMM / liquidity pool shares",
    status: lpPositive.length > 0 ? "fail" : "pass",
    detail:
      lpPositive.length > 0
        ? `${lpPositive.length} pool position(s): ${lpPositive
            .slice(0, 4)
            .map((p) => `${p.poolId.slice(0, 8)}… (${p.balance} shares)`)
            .join("; ")}${lpPositive.length > 4 ? "…" : ""}`
        : undefined,
    blocksDemolish: true,
  });

  const data = account.data ?? {};
  const dataKeys = Object.keys(data);
  push({
    id: "classic_data_entries",
    label: "No account data entries",
    status: dataKeys.length > 0 ? "fail" : "pass",
    detail: dataKeys.length > 0 ? `${dataKeys.length} entr${dataKeys.length === 1 ? "y" : "ies"}` : undefined,
    blocksDemolish: true,
  });

  const claimScanKnown = input.inboundClaimableBalanceCount !== undefined;
  const claimN = input.inboundClaimableBalanceCount ?? 0;
  push({
    id: "classic_claimable_balances",
    label: "No inbound claimable balances to claim",
    status: !claimScanKnown ? "unknown" : claimN > 0 ? "fail" : "pass",
    detail: !claimScanKnown
      ? "Horizon claimable_balances scan missing or failed."
      : claimN > 0
        ? `${claimN} balance(s) where this account is a claimant`
        : undefined,
    blocksDemolish: true,
  });

  const native = balances.find((b) => b.asset_type === "native");
  const nativeBalance = parseNum(native?.balance);
  const subentries = account.subentry_count ?? 0;
  const minBalance = (2 + subentries) * BASE_RESERVE_XLM;
  const reserveOk = nativeBalance >= minBalance - 1e-6;
  push({
    id: "classic_min_reserve",
    label: "Native balance meets minimum reserve",
    status: reserveOk ? "pass" : "fail",
    detail: `${nativeBalance.toFixed(7)} XLM (min ~${minBalance.toFixed(7)} for ${subentries} subentries)`,
    blocksDemolish: true,
  });

  push({
    id: "native_merge_payout",
    label: "Native XLM payout on merge (FYI)",
    status: "pass",
    detail: `~${nativeBalance.toFixed(7)} XLM — ACCOUNT_MERGE credits remaining native XLM to your destination (minus fee). Non-native assets are never moved by merge.`,
    blocksDemolish: false,
  });

  // —— Soroban ——
  if (!input.soroban) {
    push({
      id: "soroban_rpc",
      label: "Soroban RPC reachable",
      status: "fail",
      detail: "Internal error: Soroban scan missing from report input.",
      blocksDemolish: true,
    });
    push({
      id: "soroban_sac_balances",
      label: "No Soroban SAC token balances (native + trustline assets)",
      status: "unknown",
      detail: "Soroban scan missing.",
      blocksDemolish: true,
    });
    push({
      id: "soroban_allowances",
      label: "No active Soroban token allowances (checked spenders)",
      status: "skipped",
      detail: "Soroban scan missing.",
      blocksDemolish: false,
    });
  } else {
    const sb = input.soroban;
    push({
      id: "soroban_rpc",
      label: "Soroban RPC reachable",
      status: sb.ok ? "pass" : "fail",
      detail: sb.ok ? sb.rpcUrl : sb.errorMessage ?? sb.rpcUrl,
      blocksDemolish: true,
    });

    const positiveBalances = sb.balances.filter((b) => b.hasEntry && BigInt(b.amount || "0") > 0n);
    push({
      id: "soroban_sac_balances",
      label: "No Soroban SAC token balances (native + trustline assets)",
      status: !sb.ok ? "unknown" : positiveBalances.length === 0 ? "pass" : "fail",
      detail:
        positiveBalances.length === 0
          ? sb.balances.length > 0
            ? `Checked ${sb.balances.length} SAC contract(s), all zero.`
            : "No SAC contracts to check."
          : positiveBalances.map((b) => `${b.assetLabel}: ${b.amount}`).join("; "),
      blocksDemolish: true,
    });

    let allowStatus: ChecklistStatus;
    let allowDetail: string | undefined;
    if (!sb.ok) {
      allowStatus = "unknown";
      allowDetail = "Soroban RPC failed.";
    } else if (sb.allowanceCheckIncomplete) {
      allowStatus = "skipped";
      allowDetail =
        "No spenders configured. Set API env SOROBAN_ALLOWANCE_SPENDERS (comma-separated C contract addresses) to verify allowances.";
    } else if (sb.allowances.some((a) => BigInt(a.amount || "0") > 0n)) {
      allowStatus = "fail";
      allowDetail = sb.allowances
        .filter((a) => BigInt(a.amount || "0") > 0n)
        .map((a) => `${a.assetLabel} → ${a.spender.slice(0, 8)}… : ${a.amount}`)
        .join("; ");
    } else {
      allowStatus = "pass";
      allowDetail = sb.allowances.length === 0 ? "No spenders configured or all allowances zero." : "All checked allowances are zero.";
    }
    push({
      id: "soroban_allowances",
      label: "No active Soroban token allowances (checked spenders)",
      status: allowStatus,
      detail: allowDetail,
      blocksDemolish: allowStatus === "fail" || allowStatus === "unknown",
    });
  }

  const defiNet: "testnet" | "mainnet" = input.ledgerNetwork === "mainnet" ? "mainnet" : "testnet";
  const surfaces =
    input.openPositions?.defiProtocols && input.openPositions.defiProtocols.length > 0
      ? input.openPositions.defiProtocols
      : defiProtocolSurfacesForNetwork(defiNet);

  let defiStatus: ChecklistStatus = "pass";
  if (surfaces.some((s) => s.status === "fail")) defiStatus = "fail";
  else if (surfaces.some((s) => s.status === "unknown")) defiStatus = "unknown";

  const defiDetail = surfaces.map((s) => `${s.label}: ${s.status} — ${s.detail}`).join(" | ");

  push({
    id: "defi_positions",
    label: "DeFi positions (Blend, Aquarius, Soroswap, …)",
    status: defiStatus,
    detail: defiDetail,
    blocksDemolish: surfaces.some((s) => s.status === "fail"),
  });

  const blockers = checklistToBlockers(checklist, nativeBalance);
  const failCount = checklist.filter((c) => c.blocksDemolish && c.status === "fail").length;
  const inconclusive = checklist.filter((c) => c.blocksDemolish && c.status === "unknown").length;
  const allClear = checklist.every((c) => !c.blocksDemolish || c.status === "pass" || c.status === "skipped");
  const summary = allClear
    ? "All required checks passed or skipped. Confirm destination; if any DeFi row is unknown, confirm those protocols manually before merge."
    : `${failCount} failing check(s)${inconclusive > 0 ? `; ${inconclusive} inconclusive (unknown)` : ""} — see checklist.`;

  const resolvedOpenPositions: OpenPositionsSnapshot = {
    sdexOffers: offerRows,
    liquidityPoolShares: lpRowsAll,
    defiProtocols: surfaces,
  };

  return finalizeReport({
    accountId: account.id,
    blockers,
    summary,
    checklist,
    input,
    nativeBalance,
    openPositions: resolvedOpenPositions,
  });
}

function fillRemainingUnknown(list: HealthChecklistItem[]) {
  const have = new Set(list.map((x) => x.id));
  const rest: Array<{ id: string; label: string }> = [
    { id: "account_exists", label: "Account exists on Horizon" },
    { id: "classic_sponsorship", label: "Not sponsoring other accounts' reserves" },
    { id: "classic_extra_signers", label: "No extra account signers (merge-friendly)" },
    { id: "classic_thresholds", label: "Signature thresholds are merge-friendly" },
    { id: "classic_trustlines", label: "No classic trustlines / non-native balances" },
    { id: "classic_open_offers", label: "No open classic (SDEX) offers" },
    { id: "classic_amm_lp_shares", label: "No classic AMM / liquidity pool shares" },
    { id: "classic_claimable_balances", label: "No inbound claimable balances to claim" },
    { id: "classic_data_entries", label: "No account data entries" },
    { id: "classic_min_reserve", label: "Native balance meets minimum reserve" },
    { id: "native_merge_payout", label: "Native XLM payout on merge (FYI)" },
    { id: "soroban_rpc", label: "Soroban RPC reachable" },
    { id: "soroban_sac_balances", label: "No Soroban SAC token balances (native + trustline assets)" },
    { id: "soroban_allowances", label: "No active Soroban token allowances (checked spenders)" },
    { id: "defi_positions", label: "DeFi positions (Blend, Aquarius, Soroswap, …)" },
  ];
  for (const r of rest) {
    if (!have.has(r.id)) {
      list.push({ ...r, status: "unknown", detail: "Not evaluated.", blocksDemolish: false });
    }
  }
}

function mkBlocker(code: BlockerCode, order: number, kind: "blocking" | "informational", title: string, description: string): Blocker {
  return { code, order, kind, title, description };
}

function checklistToBlockers(checklist: HealthChecklistItem[], nativeBalance: number | undefined): Blocker[] {
  const out: Blocker[] = [];
  const row = (id: string) => checklist.find((c) => c.id === id);

  const addFrom = (id: string, code: BlockerCode, order: number, title: string, descFn: (d?: string) => string) => {
    const c = row(id);
    if (c?.status === "fail" && c.blocksDemolish) {
      out.push(mkBlocker(code, order, "blocking", title, descFn(c.detail)));
    }
  };

  addFrom("address_format", "INVALID_ACCOUNT_ID", 0, "Invalid Stellar address", (d) => d ?? "Invalid format");
  addFrom("account_exists", "ACCOUNT_NOT_FOUND", 1, "Account not found", (d) => d ?? "Not on this network");
  addFrom("classic_sponsorship", "SPONSORING_OTHER_ACCOUNTS", 10, "Sponsoring other reserves", (d) => d ?? "Resolve sponsorships before merge.");
  addFrom("classic_extra_signers", "MULTISIG_OR_EXTRA_SIGNERS", 20, "Extra signers on account", (d) => d ?? "Remove extra signers.");
  addFrom("classic_thresholds", "NON_DEFAULT_THRESHOLDS", 25, "Non-default signature thresholds", (d) => d ?? "Adjust thresholds.");
  addFrom("classic_trustlines", "TRUSTLINES_OR_ASSET_BALANCES", 30, "Trustlines or non-native balances", (d) => d ?? "Remove trustlines.");
  addFrom("classic_open_offers", "OPEN_OFFERS", 35, "Open DEX offers", (d) => d ?? "Cancel offers.");
  addFrom("classic_amm_lp_shares", "OPEN_LIQUIDITY_POOL", 36, "Classic AMM / liquidity pool shares", (d) => d ?? "Withdraw pool liquidity.");
  addFrom("classic_claimable_balances", "CLAIMABLE_BALANCES_PENDING", 38, "Inbound claimable balances", (d) => d ?? "Claim balances you are entitled to.");
  addFrom("classic_data_entries", "DATA_ENTRIES", 40, "Data entries present", (d) => d ?? "Remove data entries.");
  addFrom("classic_min_reserve", "LOW_RESERVE", 5, "Below minimum reserve", (d) => d ?? "Fund or reduce subentries.");

  const rpc = row("soroban_rpc");
  if (rpc?.status === "fail" && rpc.blocksDemolish) {
    out.push(mkBlocker("SOROBAN_RPC", 45, "blocking", "Soroban RPC error", rpc.detail ?? "Cannot reach Soroban RPC."));
  }
  const sac = row("soroban_sac_balances");
  if (sac?.blocksDemolish && (sac.status === "fail" || sac.status === "unknown")) {
    const title = sac.status === "fail" ? "Soroban token balance on SAC" : "Soroban SAC balances not verified";
    out.push(mkBlocker("SOROBAN_TOKEN_BALANCE", 46, "blocking", title, sac.detail ?? ""));
  }
  const alw = row("soroban_allowances");
  if (alw?.blocksDemolish && (alw.status === "fail" || alw.status === "unknown")) {
    const title = alw.status === "fail" ? "Active Soroban token allowance" : "Soroban allowances not verified";
    out.push(mkBlocker("SOROBAN_ALLOWANCE", 47, "blocking", title, alw.detail ?? "Resolve RPC or allowance state."));
  }

  if (row("native_merge_payout")?.status === "pass" && nativeBalance !== undefined && nativeBalance > 1e-7) {
    out.push(
      mkBlocker(
        "NATIVE_PAYOUT_ON_MERGE",
        50,
        "informational",
        "Native XLM will go to your merge destination",
        row("native_merge_payout")?.detail ?? "",
      ),
    );
  }

  const defi = row("defi_positions");
  if (defi?.status === "fail" && defi.blocksDemolish) {
    out.push(mkBlocker("DEFI_POSITIONS_OPEN", 37, "blocking", "Reported DeFi exposure", defi.detail ?? "Close Soroban DeFi positions before merge."));
  } else {
    out.push(
      mkBlocker(
        "DEFI_POSITIONS_UNKNOWN",
        100,
        "informational",
        "DeFi protocols (manual verification)",
        row("defi_positions")?.detail ?? "Per-protocol Soroban scans are not fully automated yet.",
      ),
    );
  }

  out.sort((a, b) => a.order - b.order);
  return out;
}

function finalizeReport(opts: {
  accountId: string;
  blockers: Blocker[];
  summary: string;
  checklist: HealthChecklistItem[];
  input: BuildHealthReportInput;
  nativeBalance: number | undefined;
  openPositions?: OpenPositionsSnapshot;
}): HealthReport {
  const canDemolish = opts.checklist.every((c) => !c.blocksDemolish || c.status === "pass" || c.status === "skipped");
  return {
    accountId: opts.accountId,
    sequence: opts.input.horizonAccount?.sequence,
    blockers: opts.blockers,
    canDemolish,
    summary: opts.summary,
    ledgerNetwork: opts.input.ledgerNetwork,
    horizonUrl: opts.input.horizonUrl,
    sorobanRpcUrl: opts.input.sorobanRpcUrl,
    nativeBalanceXlm: opts.nativeBalance,
    checklist: opts.checklist,
    classicAccount: opts.input.horizonAccount
      ? {
          sponsorships: {
            sponsoringCount: opts.input.horizonAccount.num_sponsoring ?? 0,
            entries: opts.input.sponsoredEntries,
          },
          signers: {
            accountId: opts.input.horizonAccount.id,
            masterWeight: opts.input.horizonAccount.signers?.find((s) => s.key === opts.input.horizonAccount?.id)?.weight ?? 0,
            extra: (opts.input.horizonAccount.signers ?? [])
              .filter((s) => s.key !== opts.input.horizonAccount?.id)
              .map((s) => ({ key: s.key, weight: s.weight })),
          },
          thresholds: {
            low: opts.input.horizonAccount.thresholds?.low_threshold ?? 1,
            medium: opts.input.horizonAccount.thresholds?.med_threshold ?? 0,
            high: opts.input.horizonAccount.thresholds?.high_threshold ?? 0,
            mergeFriendly:
              (opts.input.horizonAccount.thresholds?.low_threshold ?? 1) <= 1 &&
              (opts.input.horizonAccount.thresholds?.med_threshold ?? 0) === 0 &&
              (opts.input.horizonAccount.thresholds?.high_threshold ?? 0) === 0,
          },
        }
      : undefined,
    openPositions: opts.openPositions,
  };
}

/** @deprecated use buildHealthReport */
export function analyzeAccountHealth(accountId: string, account: HorizonAccountShape | null, offersCount: number): HealthReport {
  const noopSoroban: SorobanScanResult = {
    rpcUrl: "",
    ok: true,
    balances: [],
    allowances: [],
    allowanceCheckIncomplete: true,
  };
  return buildHealthReport({
    accountId,
    ledgerNetwork: "testnet",
    horizonUrl: "",
    sorobanRpcUrl: "",
    horizonAccount: account,
    offersCount,
    soroban: noopSoroban,
    openPositions: null,
  });
}

export interface AccountSnapshotPlaceholder {
  accountId: string;
  network: StellarNetwork;
  mergeBlockers: { code: string; message: string }[];
}

export function placeholderSnapshot(accountId: string, network: StellarNetwork): AccountSnapshotPlaceholder {
  return {
    accountId,
    network,
    mergeBlockers: [],
  };
}
