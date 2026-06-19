import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LiveStatsNetwork = "testnet" | "mainnet";
export type LiveStatsEventKind = "cleanup" | "close";

export type LiveStatsSnapshot = {
  testnetClosedCount: number;
  mainnetClosedCount: number;
  recoveredXlmTotal: number;
  updatedAt: string | null;
};

type LiveStatsStore = LiveStatsSnapshot & {
  processedEventIds: string[];
};

export type LiveStatsEventInput = {
  id: string;
  kind: LiveStatsEventKind;
  network: LiveStatsNetwork;
  recoveredXlm?: number;
};

const MAX_EVENT_IDS = 500;
const DEFAULT_STORE: LiveStatsStore = {
  testnetClosedCount: 0,
  mainnetClosedCount: 0,
  recoveredXlmTotal: 0,
  updatedAt: null,
  processedEventIds: [],
};

const statsFilePath = process.env.ORBITWAY_LIVE_STATS_FILE?.trim() || join(process.cwd(), "data", "live-stats.json");

let cachedStore: LiveStatsStore | null = null;

function cloneStore(store: LiveStatsStore): LiveStatsStore {
  return {
    ...store,
    processedEventIds: [...store.processedEventIds],
  };
}

function sanitizeStore(input: Partial<LiveStatsStore> | null | undefined): LiveStatsStore {
  const processedEventIds = Array.isArray(input?.processedEventIds)
    ? input!.processedEventIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(-MAX_EVENT_IDS)
    : [];

  return {
    testnetClosedCount: Number.isFinite(input?.testnetClosedCount) ? Math.max(0, Math.trunc(input!.testnetClosedCount as number)) : 0,
    mainnetClosedCount: Number.isFinite(input?.mainnetClosedCount) ? Math.max(0, Math.trunc(input!.mainnetClosedCount as number)) : 0,
    recoveredXlmTotal: normalizeAmount(input?.recoveredXlmTotal),
    updatedAt: typeof input?.updatedAt === "string" && input.updatedAt.trim().length > 0 ? input.updatedAt : null,
    processedEventIds,
  };
}

function normalizeAmount(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 1_000_000) / 1_000_000;
}

async function readStore(): Promise<LiveStatsStore> {
  if (cachedStore) return cloneStore(cachedStore);

  try {
    const raw = await readFile(statsFilePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LiveStatsStore>;
    cachedStore = sanitizeStore(parsed);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
    cachedStore = code === "ENOENT" ? cloneStore(DEFAULT_STORE) : cloneStore(DEFAULT_STORE);
  }

  return cloneStore(cachedStore);
}

async function writeStore(store: LiveStatsStore): Promise<void> {
  cachedStore = cloneStore(store);
  await mkdir(dirname(statsFilePath), { recursive: true });
  await writeFile(statsFilePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function toSnapshot(store: LiveStatsStore): LiveStatsSnapshot {
  return {
    testnetClosedCount: store.testnetClosedCount,
    mainnetClosedCount: store.mainnetClosedCount,
    recoveredXlmTotal: store.recoveredXlmTotal,
    updatedAt: store.updatedAt,
  };
}

export async function getLiveStatsSnapshot(): Promise<LiveStatsSnapshot> {
  return toSnapshot(await readStore());
}

export async function recordLiveStatsEvent(input: LiveStatsEventInput): Promise<LiveStatsSnapshot> {
  const id = input.id.trim();
  if (!id) {
    throw new Error("Stats event id is required.");
  }

  const network = input.network;
  const kind = input.kind;
  const recoveredXlm = normalizeAmount(input.recoveredXlm);
  const current = await readStore();

  if (current.processedEventIds.includes(id)) {
    return toSnapshot(current);
  }

  const next: LiveStatsStore = cloneStore(current);
  next.processedEventIds = [...next.processedEventIds, id].slice(-MAX_EVENT_IDS);
  next.updatedAt = new Date().toISOString();

  if (kind === "close") {
    if (network === "testnet") {
      next.testnetClosedCount += 1;
    } else if (network === "mainnet") {
      next.mainnetClosedCount += 1;
    }
  }

  if (recoveredXlm > 0) {
    next.recoveredXlmTotal = normalizeAmount(next.recoveredXlmTotal + recoveredXlm);
  }

  await writeStore(next);
  return toSnapshot(next);
}
