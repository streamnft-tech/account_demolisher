import type { ChecklistStatus } from "./health.js";

/** One open classic SDEX offer (seller = account being checked). */
export interface SdexOfferRow {
  id: string;
  /** Human-readable selling leg */
  selling: string;
  /** Human-readable buying leg */
  buying: string;
  amount: string;
  price: string;
  /** Raw Horizon `selling` object — required to build cancel transactions. */
  sellingAsset: Record<string, unknown>;
  /** Raw Horizon `buying` object */
  buyingAsset: Record<string, unknown>;
}

/** Classic AMM / constant-product pool shares held by the account (CAP-38). */
export interface LpShareRow {
  poolId: string;
  balance: string;
}

/** Known protocol surface (contracts differ per ledger network). */
export interface DefiProtocolSurface {
  id: "blend" | "aquarius" | "soroswap";
  label: string;
  status: ChecklistStatus;
  detail: string;
  /** Primary Soroban contract IDs for this ledger (C…), for support / manual unwind. */
  contractIds: string[];
}

export interface OpenPositionsSnapshot {
  sdexOffers: SdexOfferRow[];
  liquidityPoolShares: LpShareRow[];
  defiProtocols: DefiProtocolSurface[];
}

export function extractLiquidityPoolSharesFromHorizonBalances(
  balances: Array<Record<string, unknown>> | undefined,
): LpShareRow[] {
  if (!balances?.length) return [];
  const out: LpShareRow[] = [];
  for (const b of balances) {
    const assetType = typeof b.asset_type === "string" ? b.asset_type : "";
    if (assetType !== "liquidity_pool_shares") continue;
    const poolId =
      (typeof b.liquidity_pool_id === "string" && b.liquidity_pool_id) ||
      (typeof (b as { liquidty_pool_id?: string }).liquidty_pool_id === "string"
        ? (b as { liquidty_pool_id?: string }).liquidty_pool_id
        : "");
    const balance = typeof b.balance === "string" ? b.balance : "0";
    if (!poolId) continue;
    out.push({ poolId, balance });
  }
  return out;
}

export function defiProtocolSurfacesForNetwork(network: "testnet" | "mainnet"): DefiProtocolSurface[] {
  if (network === "mainnet") {
    return [
      {
        id: "blend",
        label: "Blend (lending / backstop)",
        status: "unknown",
        detail:
          "Soroban positions are not read automatically yet. Close Blend pool/backstop positions in the Blend app before merge. v2 backstop (mainnet): CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7.",
        contractIds: [
          "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7",
          "CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU",
          "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY",
        ],
      },
      {
        id: "aquarius",
        label: "Aquarius AMM",
        status: "unknown",
        detail:
          "Aquarius Soroban LP and farms are not unwound from this UI yet. Mainnet AMM entry: CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK.",
        contractIds: ["CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK"],
      },
      {
        id: "soroswap",
        label: "Soroswap",
        status: "unknown",
        detail:
          "Soroswap router/factory positions require Soroban invokes (not automated here). Mainnet factory: CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2.",
        contractIds: ["CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2", "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH"],
      },
    ];
  }
  return [
    {
      id: "blend",
      label: "Blend (lending / backstop)",
      status: "unknown",
      detail:
        "Soroban positions are not read automatically yet. Close Blend testnet positions in the Blend testnet UI. v2 backstop (testnet): CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA.",
      contractIds: [
        "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA",
        "CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6",
        "CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF",
      ],
    },
    {
      id: "aquarius",
      label: "Aquarius AMM",
      status: "unknown",
      detail:
        "Aquarius testnet AMM entry: CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD — unwind via Aquarius tools / docs.",
      contractIds: ["CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD"],
    },
    {
      id: "soroswap",
      label: "Soroswap",
      status: "unknown",
      detail:
        "Soroswap testnet factory: CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY — close LP via Soroswap UI.",
      contractIds: ["CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY", "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"],
    },
  ];
}
