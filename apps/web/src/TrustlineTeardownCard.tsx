import { useCallback, useEffect, useMemo, useState } from "react";
import { Asset } from "@stellar/stellar-sdk";
import { isValidClassicAddress } from "@stellar/core";

import type { UiNetwork } from "./network.js";
import { ensureWalletKit, formatWalletError, signWithWallet } from "./walletKit.js";
import { sdkPassphrase, submitSignedClassicTx } from "./classicClose.js";
import {
  applySlippageToPrice,
  bestBidPrice,
  buildChangeTrustZeroOnlyXdr,
  buildCrossingSellOfferForXlmXdr,
  buildPaymentAndChangeTrustZeroXdr,
  type CreditTrustlineRow,
  fetchHorizonAccountJsonFromApi,
  fetchIssuerFlagHints,
  fetchOrderBookSellCreditBuyNative,
  orderBookTooThin,
  parseCreditTrustlinesFromHorizonAccount,
} from "./trustlineTeardown.js";

type BookState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; thin: boolean; bestPrice: string | null }
  | { status: "error"; message: string };

type TrustlineActionMode = "sdex" | "soroswap" | "payout" | "remove";

export type TrustlineCleanupSummary = {
  total: number;
  funded: number;
  empty: number;
  assetCodes: string[];
};

function rowKey(r: CreditTrustlineRow): string {
  return `${r.assetCode}:${r.assetIssuer}`;
}

function issuerLabel(issuer: string): string {
  return `${issuer.slice(0, 5)}…${issuer.slice(-4)}`;
}

export function TrustlineTeardownCard(props: {
  accountId: string;
  network: UiNetwork;
  horizonUrl: string;
  walletAddress: string | null;
  walletMismatch: boolean;
  walletBusy: boolean;
  setWalletBusy: (v: boolean) => void;
  setWalletError: (msg: string | null) => void;
  setActionSuccess: (msg: string | null) => void;
  offersBlocked?: boolean;
  onSummaryChange?: (summary: TrustlineCleanupSummary) => void;
  onSubmitted: () => Promise<void>;
  embedded?: boolean;
}) {
  const {
    accountId,
    network,
    horizonUrl,
    walletAddress,
    walletMismatch,
    walletBusy,
    setWalletBusy,
    setWalletError,
    setActionSuccess,
    offersBlocked = false,
    onSummaryChange,
    onSubmitted,
    embedded = false,
  } = props;

  const [rows, setRows] = useState<CreditTrustlineRow[]>([]);
  const [rawByKey, setRawByKey] = useState<Record<string, Record<string, unknown>>>({});
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [bookByKey, setBookByKey] = useState<Record<string, BookState>>({});
  const [payoutByKey, setPayoutByKey] = useState<Record<string, string>>({});
  const [confirmPayoutByKey, setConfirmPayoutByKey] = useState<Record<string, boolean>>({});
  const [slippageBpsByKey, setSlippageBpsByKey] = useState<Record<string, number>>({});
  const [issuerHintsByKey, setIssuerHintsByKey] = useState<Record<string, string[]>>({});
  const [soroswapConfigured, setSoroswapConfigured] = useState<boolean | null>(null);
  const [actionModeByKey, setActionModeByKey] = useState<Record<string, TrustlineActionMode>>({});

  const ready =
    Boolean(walletAddress) && !walletMismatch && walletAddress === accountId && Boolean(horizonUrl);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/soroswap/status")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { configured?: boolean }) => {
        if (!cancelled) setSoroswapConfigured(Boolean(j.configured));
      })
      .catch(() => {
        if (!cancelled) setSoroswapConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoadErr(null);
    try {
      const raw = await fetchHorizonAccountJsonFromApi(accountId, network);
      const parsed = parseCreditTrustlinesFromHorizonAccount(raw);
      setRows(parsed);
      const balances = Array.isArray(raw.balances) ? raw.balances : [];
      const map: Record<string, Record<string, unknown>> = {};
      for (const b of balances) {
        if (!b || typeof b !== "object" || Array.isArray(b)) continue;
        const rec = b as Record<string, unknown>;
        const t = typeof rec.asset_type === "string" ? rec.asset_type : "";
        if (t !== "credit_alphanum4" && t !== "credit_alphanum12") continue;
        const code = String(rec.asset_code ?? "");
        const issuer = String(rec.asset_issuer ?? "");
        if (!code || !issuer) continue;
        map[`${code}:${issuer}`] = rec;
      }
      setRawByKey(map);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Failed to load trustlines");
      setRows([]);
      setRawByKey({});
    }
  }, [accountId, network]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const positiveRows = useMemo(() => rows.filter((r) => r.balanceNum > 1e-7), [rows]);
  const zeroRows = useMemo(() => rows.filter((r) => r.balanceNum <= 1e-7), [rows]);
  const allRows = useMemo(() => [...positiveRows, ...zeroRows], [positiveRows, zeroRows]);

  useEffect(() => {
    onSummaryChange?.({
      total: rows.length,
      funded: positiveRows.length,
      empty: zeroRows.length,
      assetCodes: rows.map((row) => row.assetCode),
    });
  }, [rows, positiveRows.length, zeroRows.length, onSummaryChange]);

  useEffect(() => {
    let cancelled = false;
    async function loadBooks() {
      const next: Record<string, BookState> = {};
      for (const r of positiveRows) {
        const k = rowKey(r);
        next[k] = { status: "loading" };
      }
      if (positiveRows.length > 0) setBookByKey((prev) => ({ ...prev, ...next }));

      await Promise.all(
        positiveRows.map(async (r) => {
          const k = rowKey(r);
          try {
            const { bids } = await fetchOrderBookSellCreditBuyNative({
              network,
              assetCode: r.assetCode,
              assetIssuer: r.assetIssuer,
            });
            if (cancelled) return;
            const thin = orderBookTooThin(r.balance, bids);
            const bp = bestBidPrice(bids);
            setBookByKey((prev) => ({
              ...prev,
              [k]: { status: "ok", thin, bestPrice: bp },
            }));
          } catch (e) {
            if (cancelled) return;
            setBookByKey((prev) => ({
              ...prev,
              [k]: { status: "error", message: e instanceof Error ? e.message : "Order book error" },
            }));
          }
        }),
      );
    }
    void loadBooks();
    return () => {
      cancelled = true;
    };
  }, [positiveRows, network]);

  useEffect(() => {
    let cancelled = false;
    async function hints() {
      const issuers = [...new Set(rows.map((r) => r.assetIssuer))];
      const acc: Record<string, string[]> = {};
      await Promise.all(
        issuers.map(async (issuer) => {
          const h = await fetchIssuerFlagHints(issuer, network);
          if (cancelled) return;
          for (const r of rows) {
            if (r.assetIssuer === issuer) acc[rowKey(r)] = h;
          }
        }),
      );
      if (!cancelled) setIssuerHintsByKey(acc);
    }
    if (rows.length > 0) void hints();
    return () => {
      cancelled = true;
    };
  }, [rows, accountId, network]);

  useEffect(() => {
    setPayoutByKey((prev) => {
      const n = { ...prev };
      for (const r of rows) {
        const k = rowKey(r);
        if (n[k] === undefined) n[k] = r.assetIssuer;
      }
      return n;
    });
    setSlippageBpsByKey((prev) => {
      const n = { ...prev };
      for (const r of rows) {
        const k = rowKey(r);
        if (n[k] === undefined) n[k] = 100;
      }
      return n;
    });
  }, [rows]);

  useEffect(() => {
    setActionModeByKey((prev) => {
      const next = { ...prev };
      for (const row of rows) {
        const key = rowKey(row);
        if (next[key]) continue;
        if (row.balanceNum <= 1e-7) {
          next[key] = "remove";
          continue;
        }
        const book = bookByKey[key];
        if (book?.status === "ok" && !book.thin && book.bestPrice) {
          next[key] = "sdex";
        } else if (soroswapConfigured === true) {
          next[key] = "soroswap";
        } else {
          next[key] = "payout";
        }
      }
      return next;
    });
  }, [rows, bookByKey, soroswapConfigured]);

  const signSubmit = useCallback(
    async (xdr: string) => {
      if (!walletAddress) throw new Error("Connect wallet first.");
      await ensureWalletKit(network);
      const signed = await signWithWallet(network, xdr, {
        networkPassphrase: sdkPassphrase(network),
        address: walletAddress,
      });
      const signedTxXdr = signed.signedTxXdr;
      if (!signedTxXdr) throw new Error("Wallet did not return a signed transaction.");
      return submitSignedClassicTx(horizonUrl, signedTxXdr, network);
    },
    [walletAddress, network, horizonUrl],
  );

  const onSell = async (r: CreditTrustlineRow) => {
    if (!ready) return;
    const k = rowKey(r);
    const book = bookByKey[k];
    if (!book || book.status !== "ok" || book.thin || !book.bestPrice) return;
    const slip = slippageBpsByKey[k] ?? 100;
    setWalletBusy(true);
    setWalletError(null);
    setActionSuccess(null);
    try {
      const limitPrice = applySlippageToPrice(book.bestPrice, slip);
      const xdr = await buildCrossingSellOfferForXlmXdr({
        horizonUrl,
        sourceAccount: accountId,
        network,
        assetCode: r.assetCode,
        assetIssuer: r.assetIssuer,
        sellAmount: r.balance,
        limitPrice,
      });
      const { hash } = await signSubmit(xdr);
      setActionSuccess(`Sell submitted (crossing SDEX). Tx ${hash.slice(0, 10)}… Re-run health when Horizon catches up.`);
      await onSubmitted();
      await reload();
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  };

  const onSoroswapSell = async (r: CreditTrustlineRow) => {
    if (!ready) return;
    const k = rowKey(r);
    const slip = slippageBpsByKey[k] ?? 100;
    setWalletBusy(true);
    setWalletError(null);
    setActionSuccess(null);
    try {
      const q = new URLSearchParams({ network });
      const res = await fetch(`/api/soroswap/swap-xdr?${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAccount: accountId,
          assetCode: r.assetCode,
          assetIssuer: r.assetIssuer,
          sellAmount: r.balance,
          slippageBps: slip,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text.slice(0, 400);
        try {
          const j = JSON.parse(text) as { message?: string };
          if (j.message) msg = j.message;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const body = JSON.parse(text) as { xdr?: string };
      if (!body.xdr) throw new Error("API returned no XDR.");
      const { hash } = await signSubmit(body.xdr);
      setActionSuccess(
        `Soroswap route submitted. Tx ${hash.slice(0, 10)}… If the wallet showed a Soroban transaction, confirm fees and footprints. Re-run health when Horizon catches up.`,
      );
      await onSubmitted();
      await reload();
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  };

  const onPayIssuerAndRemove = async (r: CreditTrustlineRow) => {
    if (!ready) return;
    const k = rowKey(r);
    if (!confirmPayoutByKey[k]) {
      setWalletError("Confirm payout risk before sending.");
      return;
    }
    const dest = (payoutByKey[k] ?? "").trim();
    if (!isValidClassicAddress(dest)) {
      setWalletError("Enter a valid payout G-address.");
      return;
    }
    setWalletBusy(true);
    setWalletError(null);
    setActionSuccess(null);
    try {
      const asset = new Asset(r.assetCode, r.assetIssuer);
      const xdr = await buildPaymentAndChangeTrustZeroXdr({
        horizonUrl,
        sourceAccount: accountId,
        network,
        asset,
        amount: r.balance,
        destination: dest,
      });
      const { hash } = await signSubmit(xdr);
      setActionSuccess(`Payment + trustline removal submitted. Tx ${hash.slice(0, 10)}…`);
      await onSubmitted();
      await reload();
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  };

  const onRemoveZeroOnly = async (r: CreditTrustlineRow) => {
    if (!ready) return;
    if (r.balanceNum > 1e-7) {
      setWalletError("Balance must be zero before removing this trustline.");
      return;
    }
    const raw = rawByKey[rowKey(r)];
    if (!raw) {
      setWalletError("Missing Horizon balance row — refresh and retry.");
      return;
    }
    setWalletBusy(true);
    setWalletError(null);
    setActionSuccess(null);
    try {
      const xdr = await buildChangeTrustZeroOnlyXdr({
        horizonUrl,
        sourceAccount: accountId,
        network,
        balanceRecord: raw,
      });
      const { hash } = await signSubmit(xdr);
      setActionSuccess(`ChangeTrust (limit 0) submitted. Tx ${hash.slice(0, 10)}…`);
      await onSubmitted();
      await reload();
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  };

  if (rows.length === 0 && !loadErr) {
    return (
      <div className={embedded ? "trustlineEmbedded trustlineEmbedded--empty" : "card trustlineCard"}>
        <div className="sectionHeaderRow">
          <div>
            <h2 className={embedded ? "trustlineEmbeddedTitle" : "cardTitle"}>
              {embedded ? "Per-token cleanup planner" : "Trustlines and offers"}
            </h2>
            <p className="hint">No funded credit lines were returned by the latest scan.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={embedded ? "trustlineEmbedded" : "card trustlineCard"}>
      <div className="sectionHeaderRow trustlineSectionHeader">
        <div>
          <h2 className={embedded ? "trustlineEmbeddedTitle" : "cardTitle"}>
            {embedded ? "Per-token cleanup planner" : "Trustlines and offers"}
          </h2>
          <p className="hint">
            Review one token line at a time. Swap, return, or remove the balance, then close the trustline to release the
            reserve attached to that line.
          </p>
        </div>
      </div>
      {offersBlocked ? (
        <div className="trustlineNotice trustlineNotice--warn">
          Open offers may need to be cancelled first. Offers can block trustline removal for the same asset.
        </div>
      ) : null}
      {!ready ? (
        <div className="trustlineNotice trustlineNotice--error">
          Connect the source account wallet to run trustline actions and sign the selected cleanup step.
        </div>
      ) : null}
      {loadErr ? <p className="error">{loadErr}</p> : null}
      <ul className="trustlineList">
        {allRows.map((r) => {
          const k = rowKey(r);
          const book = bookByKey[k] ?? { status: "idle" };
          const slip = slippageBpsByKey[k] ?? 100;
          const hasBalance = r.balanceNum > 1e-7;
          const canSell = book.status === "ok" && !book.thin && book.bestPrice !== null && ready && !walletBusy;
          const canSoroswapSell = soroswapConfigured === true && ready && !walletBusy;
          const mode = actionModeByKey[k] ?? (hasBalance ? "payout" : "remove");
          const hints = issuerHintsByKey[k] ?? [];
          const actionOptions: Array<{ value: TrustlineActionMode; label: string; disabled?: boolean }> = hasBalance
            ? [
                {
                  value: "sdex",
                  label:
                    book.status === "loading"
                      ? "SDEX swap · checking liquidity"
                      : book.status === "error"
                        ? "SDEX swap · unavailable"
                        : book.status === "ok" && book.thin
                          ? "SDEX swap · book too thin"
                          : "SDEX swap to XLM",
                  disabled: !(book.status === "ok" && !book.thin && book.bestPrice),
                },
                {
                  value: "soroswap",
                  label: soroswapConfigured ? "Soroswap route" : "Soroswap route · unavailable",
                  disabled: soroswapConfigured !== true,
                },
                { value: "payout", label: "Send full token balance" },
              ]
            : [{ value: "remove", label: "Remove empty trustline" }];

          const primaryAction =
            mode === "sdex"
              ? { label: "Swap on SDEX", disabled: !canSell, run: () => void onSell(r) }
              : mode === "soroswap"
                ? {
                    label: soroswapConfigured ? "Swap via Soroswap" : "Soroswap unavailable",
                    disabled: !canSoroswapSell,
                    run: () => void onSoroswapSell(r),
                  }
                : mode === "payout"
                  ? {
                      label: "Send token + remove trustline",
                      disabled: !ready || walletBusy,
                      run: () => void onPayIssuerAndRemove(r),
                    }
                  : {
                      label: "Remove trustline",
                      disabled: !ready || walletBusy,
                      run: () => void onRemoveZeroOnly(r),
                    };

          return (
            <li key={k} className="trustlineTokenShell">
              <details className="trustlineToken">
                <summary className="trustlineTokenSummary">
                  <div className="trustlineTokenIdentity">
                    <strong>{r.assetCode}</strong>
                    <span>{issuerLabel(r.assetIssuer)}</span>
                  </div>
                  <div className="trustlineTokenMeta">
                    <span className={`statusBadge ${hasBalance ? "statusBadge--warn" : "statusBadge--ok"}`}>
                      {hasBalance ? "Balance to unwind" : "Ready to remove"}
                    </span>
                    <span className="trustlineReserveHint">Reserve unlocks after line removal</span>
                  </div>
                  <div className="trustlineTokenBalance">
                    <span>Balance</span>
                    <strong>{r.balance}</strong>
                  </div>
                  <span className="stateDetailGroupMeta">
                    <span>{hasBalance ? actionOptions.filter((option) => !option.disabled).length : 1} action{hasBalance && actionOptions.filter((option) => !option.disabled).length !== 1 ? "s" : ""}</span>
                    <span className="stateDetailGroupChevron" aria-hidden>
                      ⌄
                    </span>
                  </span>
                </summary>

                <div className="trustlineTokenBody">
                  <div className="trustlineFacts">
                    <div className="trustlineFact">
                      <span>Token line</span>
                      <strong>{r.assetCode}</strong>
                    </div>
                    <div className="trustlineFact">
                      <span>Issuer</span>
                      <strong>{issuerLabel(r.assetIssuer)}</strong>
                    </div>
                    <div className="trustlineFact">
                      <span>Trustline state</span>
                      <strong>{hasBalance ? "Funded" : "Empty"}</strong>
                    </div>
                    <div className="trustlineFact">
                      <span>Reserve impact</span>
                      <strong>Released after close</strong>
                    </div>
                  </div>

                  {hints.length > 0 ? (
                    <ul className="issuerHints">
                      {hints.map((h) => (
                        <li key={h}>{h}</li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="trustlinePlanner">
                    <label className="label trustlinePlannerLabel">Choose cleanup action</label>
                    <div className="trustlinePlannerControls">
                      <label className="networkSelectWrap trustlineActionSelectWrap">
                        <select
                          className="networkSelect trustlineActionSelect"
                          value={mode}
                          onChange={(event) =>
                            setActionModeByKey((prev) => ({
                              ...prev,
                              [k]: event.target.value as TrustlineActionMode,
                            }))
                          }
                        >
                          {actionOptions.map((option) => (
                            <option key={option.value} value={option.value} disabled={option.disabled}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      {(mode === "sdex" || mode === "soroswap") && hasBalance ? (
                        <label className="slipLabel">
                          Slippage (bps)
                          <input
                            className="input slipInput"
                            type="number"
                            min={0}
                            max={5000}
                            step={10}
                            value={slip}
                            onChange={(e) =>
                              setSlippageBpsByKey((prev) => ({
                                ...prev,
                                [k]: Math.max(0, Math.min(5000, Number(e.target.value) || 0)),
                              }))
                            }
                          />
                        </label>
                      ) : null}
                    </div>

                    <div className="trustlinePlannerHint">
                      {mode === "sdex"
                        ? book.status === "loading"
                          ? "Checking whether the SDEX book is deep enough for this token line."
                          : book.status === "error"
                            ? book.message
                            : book.status === "ok" && book.thin
                              ? "The current SDEX book is too thin for a clean exit. Try another route."
                              : "Use the SDEX book to convert this token into XLM before removing the trustline."
                        : mode === "soroswap"
                          ? soroswapConfigured
                            ? "Route through Soroswap when on-chain liquidity is available for a classic to native exit."
                            : "Soroswap routing is not configured in this environment."
                          : mode === "payout"
                            ? "Send the full token balance to a confirmed destination, then remove the trustline in the same signed step."
                            : "This line is already empty and can be removed directly."}
                    </div>

                    {mode === "payout" && hasBalance ? (
                      <div className="payoutBlock">
                        <label className="label">Payout target (full token balance)</label>
                        <input
                          className="input"
                          spellCheck={false}
                          value={payoutByKey[k] ?? r.assetIssuer}
                          onChange={(e) => setPayoutByKey((prev) => ({ ...prev, [k]: e.target.value }))}
                        />
                        <label className="confirmRow">
                          <input
                            type="checkbox"
                            checked={Boolean(confirmPayoutByKey[k])}
                            onChange={(e) => setConfirmPayoutByKey((prev) => ({ ...prev, [k]: e.target.checked }))}
                          />{" "}
                          I confirm this token return may be unsolicited and the destination may reject, freeze, or claw
                          back the asset under issuer policy.
                        </label>
                      </div>
                    ) : null}

                    <div className="trustlinePlannerFooter">
                      <button
                        type="button"
                        className={primaryAction.disabled ? "btn ghost" : "btn secondary"}
                        disabled={primaryAction.disabled}
                        onClick={primaryAction.run}
                      >
                        {primaryAction.label}
                      </button>
                    </div>
                  </div>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
