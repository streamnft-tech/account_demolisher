import { useCallback, useEffect, useState } from "react";
import { KitEventType } from "@creit.tech/stellar-wallets-kit/types";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import type { Blocker, BlockerCode, ChecklistStatus, HealthChecklistItem, HealthReport } from "@stellar/core";
import { isValidClassicAddress } from "@stellar/core";
import type { UiNetwork } from "./network.js";
import { ensureWalletKit, formatWalletError } from "./walletKit.js";
import {
  CLASSIC_BLOCKER_CODES,
  classicBlockerButtonLabel,
  classicBlockerButtonTitle,
  runClassicBlockerFix,
} from "./classicBlockerHandlers.js";
import type { ClassicBatchResult } from "./classicClose.js";
import { sdkPassphrase, submitSignedClassicTx } from "./classicClose.js";
import { TrustlineTeardownCard } from "./TrustlineTeardownCard.js";
import "./App.css";

function statusGlyph(s: ChecklistStatus): string {
  switch (s) {
    case "pass":
      return "✓";
    case "fail":
      return "✗";
    case "skipped":
      return "—";
    default:
      return "?";
  }
}

/** Scan outcome text once a row is evaluated (shown beside each checklist row when not loading). */
function outcomeLabel(row: HealthChecklistItem): string {
  switch (row.status) {
    case "pass":
      return "Passed";
    case "skipped":
      return "Skipped";
    case "fail":
      return row.blocksDemolish ? "Blocker" : "Failed";
    case "unknown":
      return row.blocksDemolish ? "Inconclusive" : "N/A";
  }
}

function outcomePillClass(row: HealthChecklistItem): string {
  const v =
    row.status === "pass"
      ? "passed"
      : row.status === "skipped"
        ? "skipped"
        : row.status === "fail"
          ? row.blocksDemolish
            ? "blocker"
            : "failed"
          : row.blocksDemolish
            ? "inconclusive"
            : "na";
  return `checklistOutcome checklistOutcome--${v}`;
}

const HEALTH_FETCH_TIMEOUT_MS = 90_000;

function devHealthLog(label: string, res: Response, text: string) {
  if (import.meta.env.DEV) {
    console.debug(`[health-fetch] ${label}`, { status: res.status, bytes: text.length, preview: text.slice(0, 400) });
  }
}

function fetchHealth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS) });
}

export function App() {
  const [network, setNetwork] = useState<UiNetwork>("testnet");
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void ensureWalletKit(network).then(() => {
      dispose = StellarWalletsKit.on(KitEventType.STATE_UPDATED, (ev) => {
        setWalletAddress(ev.payload?.address ?? null);
      });
    });
    return () => {
      dispose?.();
    };
  }, [network]);

  const connectWallet = useCallback(async () => {
    setWalletError(null);
    setWalletBusy(true);
    try {
      await ensureWalletKit(network);
      const { address } = await StellarWalletsKit.authModal();
      setWalletAddress(address);
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  }, [network]);

  const disconnectWallet = useCallback(async () => {
    setWalletError(null);
    setWalletBusy(true);
    try {
      await StellarWalletsKit.disconnect();
      setWalletAddress(null);
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  }, []);

  const openWalletProfile = useCallback(async () => {
    setWalletError(null);
    setWalletBusy(true);
    try {
      await ensureWalletKit(network);
      await StellarWalletsKit.profileModal();
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  }, [network]);

  const runHealthCheck = useCallback(async () => {
    setError(null);
    setHealth(null);
    setActionSuccess(null);
    const id = source.trim();
    if (!isValidClassicAddress(id)) {
      setError("Enter a valid classic G-address (56 chars).");
      return;
    }
    setLoading(true);
    try {
      const q = new URLSearchParams({ network });
      const res = await fetchHealth(`/api/account/${encodeURIComponent(id)}/health?${q}`);
      const text = await res.text();
      devHealthLog("health", res, text);
      if (!res.ok) {
        let body: { message?: string } = {};
        try {
          body = JSON.parse(text || "{}") as { message?: string };
        } catch {
          /* non-JSON error body */
        }
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      const report = JSON.parse(text) as HealthReport;
      setHealth(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Health check failed");
    } finally {
      setLoading(false);
    }
  }, [source, network]);

  const refreshHealth = useCallback(async () => {
    if (!source.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ network });
      const res = await fetchHealth(`/api/account/${encodeURIComponent(source.trim())}/health?${q}`);
      const text = await res.text();
      devHealthLog("health-refresh", res, text);
      if (!res.ok) {
        let body: { message?: string } = {};
        try {
          body = JSON.parse(text || "{}") as { message?: string };
        } catch {
          /* ignore */
        }
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      setHealth(JSON.parse(text) as HealthReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  }, [source, network]);

  const signSubmitClassicBatch = useCallback(
    async (batch: ClassicBatchResult) => {
      if (!health?.horizonUrl || !walletAddress) {
        throw new Error("Missing Horizon URL or connected wallet.");
      }
      const signed = await StellarWalletsKit.signTransaction(batch.xdr, {
        networkPassphrase: sdkPassphrase(network),
        address: walletAddress,
      });
      const signedTxXdr = signed.signedTxXdr;
      if (!signedTxXdr) throw new Error("Wallet did not return a signed transaction.");
      return submitSignedClassicTx(health.horizonUrl, signedTxXdr, network);
    },
    [health?.horizonUrl, walletAddress, network],
  );

  const resolveClassicBlocker = useCallback(
    async (code: BlockerCode) => {
      const id = source.trim();
      if (!health?.horizonUrl || !walletAddress || !isValidClassicAddress(id)) return;
      setWalletBusy(true);
      setWalletError(null);
      setActionSuccess(null);
      try {
        const msg = await runClassicBlockerFix(code, {
          accountId: id,
          horizonUrl: health.horizonUrl,
          network,
          signSubmit: signSubmitClassicBatch,
          lpShares: health.openPositions?.liquidityPoolShares,
        });
        setActionSuccess(msg);
        await refreshHealth();
      } catch (e) {
        setWalletError(formatWalletError(e));
      } finally {
        setWalletBusy(false);
      }
    },
    [health, network, source, walletAddress, refreshHealth, signSubmitClassicBatch],
  );

  const destOk = isValidClassicAddress(destination.trim());
  const blocking = health?.blockers.filter((b: Blocker) => b.kind === "blocking") ?? [];
  const info = health?.blockers.filter((b: Blocker) => b.kind === "informational") ?? [];
  const canDemolish = health?.canDemolish === true && destOk;

  const accountKnown =
    health &&
    !health.blockers.some((b) => b.code === "ACCOUNT_NOT_FOUND" || b.code === "INVALID_ACCOUNT_ID");

  const checklist: HealthChecklistItem[] = health?.checklist ?? [];
  const trustlineChecklistRow = checklist.find((r) => r.id === "classic_trustlines");
  const showTrustlineTeardown =
    accountKnown &&
    Boolean(health?.horizonUrl) &&
    (blocking.some((b) => b.code === "TRUSTLINES_OR_ASSET_BALANCES") || trustlineChecklistRow?.status === "fail");

  const sourceTrim = source.trim();
  const walletMismatch =
    walletAddress && sourceTrim && isValidClassicAddress(sourceTrim) && walletAddress !== sourceTrim;

  return (
    <div className="shell">
      <header className="header">
        <h1 className="title">Account Demolisher</h1>
        <p className="subtitle">Health check → destination → clear blockers → merge when safe</p>
      </header>

      <ol className="steps">
        <li className="active">1. Source &amp; health</li>
        <li className={accountKnown ? "active" : ""}>2. Destination</li>
        <li className={accountKnown ? "active" : ""}>3. Resolve blockers</li>
        <li className={canDemolish ? "active" : ""}>4. Demolish</li>
      </ol>

      <section className="card">
        <h2 className="cardTitle">Step 1 — Source account</h2>
        <p className="hint">
          Backend scans Horizon (classic) for merge blockers. Pick <strong>testnet</strong> or <strong>mainnet</strong>; the
          same G-address can exist on both ledgers as different accounts.
        </p>
        <div className="label">Network</div>
        <div className="segmented" role="group" aria-label="Stellar network">
          <button
            type="button"
            className={`seg ${network === "testnet" ? "active" : ""}`}
            onClick={() => {
              setNetwork("testnet");
              setHealth(null);
            }}
          >
            Testnet
          </button>
          <button
            type="button"
            className={`seg ${network === "mainnet" ? "active" : ""}`}
            onClick={() => {
              setNetwork("mainnet");
              setHealth(null);
            }}
          >
            Mainnet
          </button>
        </div>
        <div className="label">Wallet (for upcoming signed fixes)</div>
        <p className="hint">
          Uses Stellar Wallets Kit (Freighter, Albedo, xBull, LOBSTR{import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() ? ", WalletConnect" : ""}). Optional{" "}
          <code className="inlineCode">VITE_WALLETCONNECT_PROJECT_ID</code> enables WalletConnect in{" "}
          <code className="inlineCode">.env</code>.
        </p>
        <div className="walletRow">
          {walletAddress ? (
            <>
              <code className="inlineCode walletAddr" title={walletAddress}>
                {walletAddress.slice(0, 6)}…{walletAddress.slice(-6)}
              </code>
              <div className="walletActions">
                <button type="button" className="btn secondary" disabled={walletBusy} onClick={openWalletProfile}>
                  Profile
                </button>
                <button type="button" className="btn secondary" disabled={walletBusy} onClick={disconnectWallet}>
                  Disconnect
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="btn secondary" disabled={walletBusy} onClick={connectWallet}>
              {walletBusy ? "Opening…" : "Connect wallet"}
            </button>
          )}
        </div>
        {walletError ? <p className="error">{walletError}</p> : null}
        {walletMismatch ? (
          <p className="error">
            Connected wallet <code className="inlineCode">{walletAddress?.slice(0, 8)}…</code> does not match the source
            account above. Use the same account when signing cleanup transactions.
          </p>
        ) : null}
        <label className="label" htmlFor="source">
          Source account (public key)
        </label>
        <input
          id="source"
          className="input"
          placeholder="G…"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setHealth(null);
          }}
          spellCheck={false}
          autoCapitalize="none"
        />
        <div className="row">
          <button type="button" className="btn primary" disabled={loading} onClick={runHealthCheck}>
            {loading ? "Checking…" : "Run health check"}
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </section>

      {health ? (
        <section className="card">
          <h2 className="cardTitle">Health result</h2>
          <p className={`summary ${health.canDemolish ? "ok" : "warn"}`}>{health.summary}</p>
          {health.horizonUrl ? (
            <p className="meta">
              Ledger: <strong>{health.ledgerNetwork ?? network}</strong> · Horizon{" "}
              <code className="inlineCode">{health.horizonUrl}</code>
            </p>
          ) : null}
          {health.sorobanRpcUrl ? (
            <p className="meta">
              Soroban RPC: <code className="inlineCode">{health.sorobanRpcUrl}</code>
            </p>
          ) : null}
          <div className="checklist">
            <h3 className="checklistTitle">Scan checklist</h3>
            <p className="checklistHint">
              Every merge-related check we run today. When a scan finishes, each row shows an outcome pill:{" "}
              <strong>Passed</strong>, <strong>Skipped</strong>, <strong>Failed</strong> (informational only),{" "}
              <strong>Blocker</strong> (confirmed issue — merge blocked), <strong>Inconclusive</strong> (unknown but merge
              blocked until verified), or <strong>N/A</strong> (unknown and not treated as a merge gate).
            </p>
            <ul className="checklistList">
              {checklist.map((row) => (
                <li
                  key={row.id}
                  className={`checklistRow status-${row.status}`}
                  aria-label={loading ? `${row.label}: scan in progress` : `${row.label}: ${outcomeLabel(row)}`}
                >
                  <span className="checklistBadge" aria-hidden>
                    {statusGlyph(row.status)}
                  </span>
                  <div className="checklistBody">
                    <div className="checklistLabelRow">
                      <span className="checklistLabel">{row.label}</span>
                      {!loading ? <span className={outcomePillClass(row)}>{outcomeLabel(row)}</span> : null}
                    </div>
                    {row.detail ? <p className="checklistDetail">{row.detail}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          {typeof health.nativeBalanceXlm === "number" ? (
            <p className="meta">
              Classic native balance (Horizon): <strong>{health.nativeBalanceXlm.toFixed(7)} XLM</strong>
            </p>
          ) : null}
          {health.sequence ? (
            <p className="meta">
              Sequence: <code className="inlineCode">{health.sequence}</code>
            </p>
          ) : null}
          <div className="row">
            <button type="button" className="btn secondary" disabled={loading} onClick={refreshHealth}>
              Re-run health check
            </button>
          </div>
        </section>
      ) : null}

      {accountKnown ? (
        <section className="card">
          <h2 className="cardTitle">Step 2 — Merge destination</h2>
          <p className="hint">Where remaining XLM should go after cleanup. Demolish stays locked until all <em>blocking</em> issues are cleared.</p>
          <label className="label" htmlFor="dest">
            Destination account
          </label>
          <input
            id="dest"
            className="input"
            placeholder="G…"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
          />
          {!destOk && destination.trim() ? <p className="error">Invalid destination address.</p> : null}
        </section>
      ) : null}

      {showTrustlineTeardown && health?.horizonUrl ? (
        <TrustlineTeardownCard
          accountId={source.trim()}
          network={network}
          horizonUrl={health.horizonUrl}
          walletAddress={walletAddress}
          walletMismatch={Boolean(walletMismatch)}
          walletBusy={walletBusy}
          setWalletBusy={setWalletBusy}
          setWalletError={setWalletError}
          setActionSuccess={setActionSuccess}
          onSubmitted={refreshHealth}
        />
      ) : null}

      {accountKnown ? (
        <section className="card">
          <h2 className="cardTitle">Step 3 — Resolve blocking issues</h2>
          {blocking.length === 0 ? (
            <p className="summary ok">No blocking issues from the summary list. Use the checklist above for full coverage; fix any failing rows then re-run.</p>
          ) : (
            <>
              <p className="hint">
                Connect a wallet that matches the source account. Several classic blockers can be fixed in-app (sign +
                submit to Horizon, up to 100 operations per transaction; re-run after each tx if the success message says
                more work remains): sponsorship revokes, data entry removal, offer cancellation, LP share withdrawal (min
                amounts 0 — confirm in wallet), empty trustline removal, merge-friendly signer/threshold cleanup, and
                claiming inbound claimable balances. Soroban balances, allowances, DeFi, and subentry types not covered by
                the sponsor scanner still need external tools; then <strong>Re-run health check</strong>.
              </p>
              {!walletAddress ? (
                <p className="meta">Connect a wallet to sign in-app fixes where available.</p>
              ) : null}
              {actionSuccess ? <p className="summary ok">{actionSuccess}</p> : null}
              <ul className="blockerList">
                {blocking.map((b) => {
                  const isAutomated = CLASSIC_BLOCKER_CODES.has(b.code);
                  const classicReady =
                    isAutomated && Boolean(walletAddress) && !walletMismatch && Boolean(health?.horizonUrl);
                  return (
                  <li key={b.code} className="blocker blocking">
                    <div className="blockerTitle">{b.title}</div>
                    <p className="blockerDesc">{b.description}</p>
                    <button
                      type="button"
                      className={classicReady ? "btn secondary" : "btn ghost"}
                      disabled={walletBusy || !classicReady}
                      onClick={
                        classicReady
                          ? () => {
                              void resolveClassicBlocker(b.code);
                            }
                          : undefined
                      }
                      title={
                        isAutomated
                          ? classicBlockerButtonTitle(
                              b.code,
                              classicReady,
                              Boolean(walletMismatch),
                              Boolean(health?.horizonUrl),
                            )
                          : "Not automated in this app yet"
                      }
                    >
                      {isAutomated ? classicBlockerButtonLabel(b.code) : "Sign & resolve (soon)"}
                    </button>
                  </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      ) : null}

      {info.length > 0 ? (
        <section className="card muted">
          <h2 className="cardTitle">Notes</h2>
          <ul className="blockerList">
            {info.map((b) => (
              <li key={b.code} className="blocker info">
                <div className="blockerTitle">{b.title}</div>
                <p className="blockerDesc">{b.description}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {accountKnown ? (
        <section className="card">
          <h2 className="cardTitle">Step 4 — Demolish</h2>
          <p className="hint">Enabled only when health reports zero <em>blocking</em> issues and destination is valid.</p>
          <button type="button" className="btn danger" disabled={!canDemolish} title={canDemolish ? undefined : "Clear blockers and set destination first"}>
            Demolish account (merge)
          </button>
          {!canDemolish ? (
            <p className="meta">
              {blocking.length > 0
                ? `${blocking.length} blocking issue(s) remaining.`
                : !destOk
                  ? "Enter a valid destination account."
                  : "Cannot demolish yet."}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
