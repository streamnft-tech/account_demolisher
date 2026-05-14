import { Backstop, BackstopPoolUser } from "@blend-capital/blend-sdk";
import type { DefiProtocolSurface } from "@stellar/core";
import { defiProtocolSurfacesForNetwork } from "@stellar/core";
import { Networks } from "@stellar/stellar-sdk";
import type { LedgerQueryNetwork } from "./horizon.js";

const BLEND_BACKSTOP: Record<LedgerQueryNetwork, string> = {
  testnet: "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA",
  mainnet: "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7",
};

function passphraseFor(network: LedgerQueryNetwork): string {
  return network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

function hasBackstopExposure(u: BackstopPoolUser): boolean {
  const b = u.balance;
  if (b.shares > 0n) return true;
  if (b.totalQ4W > 0n) return true;
  if (b.unlockedQ4W > 0n) return true;
  if (b.q4w?.some((q) => q.amount > 0n)) return true;
  return false;
}

/**
 * Soroban-backed DeFi surface scan. Blend: reads backstop reward-zone pools via Blend SDK + RPC.
 * Aquarius / Soroswap: no stable public read API wired yet — returns static protocol rows with `unknown`.
 */
export async function scanDefiProtocols(opts: {
  accountId: string;
  network: LedgerQueryNetwork;
  sorobanRpcUrl: string;
}): Promise<DefiProtocolSurface[]> {
  const defiNet: "testnet" | "mainnet" = opts.network === "mainnet" ? "mainnet" : "testnet";
  const staticRows = defiProtocolSurfacesForNetwork(defiNet);
  const aquarius = staticRows.find((r) => r.id === "aquarius")!;
  const soroswap = staticRows.find((r) => r.id === "soroswap")!;

  const blendNetwork = {
    rpc: opts.sorobanRpcUrl,
    passphrase: passphraseFor(opts.network),
  };

  const backstopId = BLEND_BACKSTOP[opts.network];

  try {
    const backstop = await Backstop.load(blendNetwork, backstopId);
    const pools = backstop.config.rewardZone ?? [];
    if (pools.length === 0) {
      const blend: DefiProtocolSurface = {
        id: "blend",
        label: "Blend (lending / backstop)",
        status: "pass",
        detail: "Backstop loaded; reward zone lists zero pools — no RZ backstop exposure to check for this deployment.",
        contractIds: [backstopId, backstop.config.poolFactory],
      };
      return [blend, aquarius, soroswap];
    }

    const users: BackstopPoolUser[] = [];
    for (const poolId of pools) {
      try {
        users.push(await BackstopPoolUser.load(blendNetwork, backstopId, poolId, opts.accountId));
      } catch {
        /* missing ledger rows / pool not readable — treat as no exposure for that pool */
      }
    }

    if (pools.length > 0 && users.length === 0) {
      const blend: DefiProtocolSurface = {
        id: "blend",
        label: "Blend (lending / backstop)",
        status: "unknown",
        detail: `Reward zone lists ${pools.length} pool(s) but user balance rows could not be read via RPC (try again or verify network).`,
        contractIds: [backstopId],
      };
      return [blend, aquarius, soroswap];
    }

    const active = users.filter(hasBackstopExposure);
    if (active.length === 0) {
      const blend: DefiProtocolSurface = {
        id: "blend",
        label: "Blend (lending / backstop)",
        status: "pass",
        detail: `Scanned ${pools.length} reward-zone pool(s) on backstop ${backstopId.slice(0, 8)}… — no backstop shares or queued withdrawals for this account.`,
        contractIds: [backstopId, backstop.config.poolFactory],
      };
      return [blend, aquarius, soroswap];
    }

    const blend: DefiProtocolSurface = {
      id: "blend",
      label: "Blend (lending / backstop)",
      status: "fail",
      detail: `Open Blend backstop position(s) in ${active.length} pool(s): ${active
        .map((u) => u.poolId.slice(0, 8) + "…")
        .join(", ")} — unwind via Blend before merge.`,
      contractIds: [backstopId, ...active.map((u) => u.poolId)],
    };
    return [blend, aquarius, soroswap];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const blend: DefiProtocolSurface = {
      id: "blend",
      label: "Blend (lending / backstop)",
      status: "unknown",
      detail: `Blend backstop RPC scan did not complete (${msg}). Lending positions outside the reward zone are not checked here yet.`,
      contractIds: [backstopId],
    };
    return [blend, aquarius, soroswap];
  }
}
