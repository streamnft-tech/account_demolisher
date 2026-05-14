import type { FastifyBaseLogger } from "fastify";

/** Set `LOG_UPSTREAM=0` to silence. Default: log summaries (not full bodies). */
export function isUpstreamLogEnabled(): boolean {
  return process.env.LOG_UPSTREAM !== "0";
}

/** Set `LOG_UPSTREAM_BODY=1` to log the first ~4k chars of each Horizon response (noisy). */
export function isUpstreamBodyLogEnabled(): boolean {
  return process.env.LOG_UPSTREAM_BODY === "1";
}

export function logUpstream(
  log: FastifyBaseLogger | undefined,
  kind: string,
  data: Record<string, unknown>,
  bodyText?: string,
): void {
  if (!isUpstreamLogEnabled()) return;
  const payload = { kind, ...data };
  if (log) {
    log.info(payload, "upstream");
  } else {
    console.info("[upstream]", JSON.stringify({ t: new Date().toISOString(), ...payload }));
  }
  if (bodyText && isUpstreamBodyLogEnabled()) {
    const preview = bodyText.length > 4000 ? `${bodyText.slice(0, 4000)}…` : bodyText;
    if (log) log.info({ kind: `${kind}_body`, bytes: bodyText.length, preview }, "upstream_body");
    else console.info("[upstream_body]", kind, preview);
  }
}
