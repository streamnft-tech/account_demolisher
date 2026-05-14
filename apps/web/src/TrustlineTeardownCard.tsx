import { useCallback, useEffect, useMemo, useState } from "react";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { Asset } from "@stellar/stellar-sdk";
import { isValidClassicAddress } from "@stellar/core";

import type { UiNetwork } from "./network.js";
import { ensureWalletKit, formatWalletError } from "./walletKit.js";
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

function rowKey(r: CreditTrustlineRow): string {
  return `${r.assetCode}:${r.assetIssuer}`;
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
  onSubmitted: () => Promise<void>;
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
    onSubmitted,
  } = props;

  const [rows, setRows] = useState<CreditTrustlineRow[]>([]);
  const [rawByKey, setRawByKey] = useState<Record<string, Record<string, unknown>>>({});
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [bookByKey, setBookByKey] = useState<Record<string, BookState>>({});
  const [payoutByKey, setPayoutByKey] = useState<Record<string, string>>({});
  const [confirmPayoutByKey, setConfirmPayoutByKey] = useState<Record<string, boolean>>({});
  const [slippageBpsByKey, setSlippageBpsByKey] = useState<Record<string, number>>({});
  const [issuerHintsByKey, setIssuerHintsByKey] = useState<Record<string, string[]>>({});

  const ready =
    Boolean(walletAddress) && !walletMismatch && walletAddress === accountId && Boolean(horizonUrl);

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

  const signSubmit = useCallback(
    async (xdr: string) => {
      if (!walletAddress) throw new Error("Connect wallet first.");
      await ensureWalletKit(network);
      const signed = await StellarWalletsKit.signTransaction(xdr, {
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
      <div className="card trustlineCard">
        <h2 className="cardTitle">Trustlines &amp; non-native balances</h2>
        <p className="meta">No classic credit lines on this account.</p>
      </div>
    );
  }

  return (
    <div className="card trustlineCard">
      <h2 className="cardTitle">Trustlines &amp; non-native balances</h2>
      <p className="hint">
        Per-asset cleanup: optional crossing sell vs XLM when the SDEX book exists (slippage applies to the limit price),
        or pay the full Horizon balance to a <strong>user-confirmed</strong> destination (default: issuer) then{" "}
        <code className="inlineCode">ChangeTrust</code> limit 0. Issuers may reject or claw back unsolicited returns — you
        must confirm. Cancel any open offers on the asset first (offers block trustline removal). Sponsorship and
        issuer auth/clawback flags can still make operations fail — read Horizon errors carefully.
      </p>
      {!ready ? (
        <p className="error">
          Connect the source account wallet (same address as the field above) to sign trustline transactions.
        </p>
      ) : null}
      {loadErr ? <p className="error">{loadErr}</p> : null}
      <div className="row">
        <button type="button" className="btn secondary" disabled={walletBusy} onClick={() => void reload()}>
          Refresh trustlines
        </button>
      </div>
      <ul className="trustlineList">
        {positiveRows.map((r) => {
          const k = rowKey(r);
          const book = bookByKey[k] ?? { status: "idle" };
          const slip = slippageBpsByKey[k] ?? 100;
          const canSell =
            book.status === "ok" && !book.thin && book.bestPrice !== null && ready && !walletBusy;
          const sellLabel =
            book.status === "loading"
              ? "Checking SDEX…"
              : book.status === "error"
                ? "Book error"
                : book.status === "ok" && book.thin
                  ? "Not listed / too thin"
                  : book.status === "ok"
                    ? "Sell on SDEX (crossing, vs XLM)"
                    : "Sell on SDEX (crossing, vs XLM)";
          const hints = issuerHintsByKey[k] ?? [];
          return (
            <li key={k} className="trustlineItem">
              <div className="trustlineHead">
                <strong>
                  {r.assetCode}:{r.assetIssuer.slice(0, 5)}…{r.assetIssuer.slice(-4)}
                </strong>
                <span className="meta">Balance {r.balance}</span>
              </div>
              {hints.length > 0 ? (
                <ul className="issuerHints">
                  {hints.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              ) : null}
              {book.status === "error" ? <p className="meta">{book.message}</p> : null}
              <div className="trustlineActions">
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
                <button type="button" className="btn secondary" disabled={!canSell} title={sellLabel} onClick={() => void onSell(r)}>
                  {sellLabel}
                </button>
              </div>
              <div className="payoutBlock">
                <label className="label">Payout target (full balance payment)</label>
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
                  I confirm I may be sending an unsolicited return; the destination may reject, freeze, or claw back per
                  network rules and issuer policy.
                </label>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={!ready || walletBusy}
                  onClick={() => void onPayIssuerAndRemove(r)}
                >
                  Send remainder + remove line (sign)
                </button>
              </div>
            </li>
          );
        })}
        {zeroRows.map((r) => {
          const k = rowKey(r);
          return (
            <li key={k} className="trustlineItem">
              <div className="trustlineHead">
                <strong>
                  {r.assetCode}:{r.assetIssuer.slice(0, 5)}…{r.assetIssuer.slice(-4)}
                </strong>
                <span className="meta">Zero balance — remove trustline only</span>
              </div>
              <button
                type="button"
                className="btn secondary"
                disabled={!ready || walletBusy}
                onClick={() => void onRemoveZeroOnly(r)}
              >
                Remove line (ChangeTrust 0)
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
