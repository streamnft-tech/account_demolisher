import type { FastifyBaseLogger } from "fastify";

type HorizonPage = {
  _embedded?: { records?: Array<{ id?: string }> };
  _links?: { next?: { href?: string | null } | null };
};

/**
 * All claimable balances where `accountId` is a claimant (can submit `ClaimClaimableBalance`).
 */
export async function fetchClaimableBalanceIdsForClaimant(
  horizonBase: string,
  accountId: string,
  log: FastifyBaseLogger,
): Promise<string[]> {
  const base = horizonBase.replace(/\/?$/, "");
  const out: string[] = [];
  const params = new URLSearchParams({ claimant: accountId, limit: "50", order: "asc" });
  let url: string | null = `${base}/claimable_balances?${params.toString()}`;
  const seen = new Set<string>();

  while (url) {
    if (seen.has(url)) break;
    seen.add(url);
    const res = await fetch(url);
    if (!res.ok) {
      const t = await res.text();
      log.warn({ status: res.status, url: url.split("?")[0] }, "Horizon claimable_balances fetch failed");
      throw new Error(`Horizon claimable_balances ${res.status}: ${t.slice(0, 240)}`);
    }
    const json = (await res.json()) as HorizonPage;
    const recs = json._embedded?.records ?? [];
    for (const r of recs) {
      if (typeof r.id === "string" && r.id) out.push(r.id);
    }
    const next = json._links?.next?.href;
    url = recs.length > 0 && typeof next === "string" && next.length > 0 ? next : null;
  }
  return out;
}
