import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Blocker, BlockerCode, ChecklistStatus, HealthChecklistItem, HealthReport } from "@stellar/core";
import { isValidClassicAddress } from "@stellar/core";
import type { UiNetwork } from "./network.js";
import {
  connectWallet as connectWalletWithKit,
  disconnectWallet as disconnectWalletFromKit,
  ensureWalletKit,
  formatWalletError,
  signWithWallet,
} from "./walletKit.js";
import { runClassicBlockerFix } from "./classicBlockerHandlers.js";
import type { ClassicBatchResult } from "./classicClose.js";
import { sdkPassphrase, submitSignedClassicTx } from "./classicClose.js";
import { buildAccountMergeBatchXdr } from "./classicDemolish.js";
import { TrustlineTeardownCard } from "./TrustlineTeardownCard.js";
import "./App.css";

type RouteMode = "landing" | "app";
type AppSection = "scan" | "health" | "close";
type WatchlistEntry = {
  accountId: string;
  network: UiNetwork;
  savedAt: number;
  lastScannedAt?: number;
  summary?: string;
  blockersCount?: number;
  readyToClose?: boolean;
  nativeBalanceXlm?: number;
};

const HEALTH_FETCH_TIMEOUT_MS = 90_000;
const WATCHLIST_STORAGE_KEY = "stellar-sweep-watchlist";

const problemCards = [
  {
    title: "State you forgot about",
    body: "Old trustlines, signers, sponsorships, claimable balances, and data entries can stay active even after the account stops being used.",
  },
  {
    title: "Actions that block closure",
    body: "Open offers, unresolved balances, and active positions can prevent trustline removal or account merge.",
  },
  {
    title: "Value left behind",
    body: "Reserves and small balances remain stuck when users cannot identify the correct cleanup sequence.",
  },
];

const useCaseCards = [
  {
    title: "For Stellar users",
    benefit: "Recover reserves",
    body: "Recover locked reserves, remove stale trustlines, inspect active permissions, and safely close accounts when ready.",
  },
  {
    title: "For DeFi users",
    benefit: "Review permissions",
    body: "Review active allowances, detect unresolved protocol positions, and avoid leaving risky permissions behind.",
  },
  {
    title: "For wallets",
    benefit: "Add wallet safety",
    body: "Offer account health checks, cleanup flows, and safer account exit experiences directly inside wallet products.",
  },
  {
    title: "For exchanges",
    benefit: "Reduce support burden",
    body: "Help users consolidate funds and recover final reserves even when exchange addresses cannot directly receive account merge operations.",
  },
];

const safetyCards = [
  {
    title: "Scan without signing",
    body: "Run a read-only scan first. No wallet approval is needed until you choose a cleanup action.",
    featured: true,
  },
  {
    title: "Wallet-signed cleanup",
    body: "Every cleanup transaction is shown before approval and signed through the user’s wallet.",
  },
  {
    title: "Private keys stay private",
    body: "Secret keys and signing authority never move to Stellar Sweep servers.",
  },
  {
    title: "Close only when ready",
    body: "Account closure remains a separate final step and only becomes available after blockers are resolved.",
  },
];

const coverageGroups = [
  {
    title: "Classic account blockers",
    body: "Resolve account-level state that commonly prevents cleanup or closure.",
    items: ["Trustlines", "Open DEX offers", "Claimable balances", "Signers & thresholds", "Sponsorships"],
  },
  {
    title: "Soroban and DeFi signals",
    body: "Surface permissions, token balances, and protocol activity that are harder to inspect manually.",
    items: ["Token balances", "Active allowances", "LP positions", "DeFi positions", "Protocol permissions"],
  },
  {
    title: "Recovery and close actions",
    body: "Guide users from cleanup planning to reserve recovery and final account closure.",
    items: ["Reserve recovery", "Asset conversion", "Account closure", "Exchange destination flow", "Mediator account flow"],
  },
];

const ecosystemPoints = [
  {
    title: "Wallet-ready",
    body: "For wallets that need account health checks, cleanup guidance, and safer exit flows.",
  },
  {
    title: "Self-hostable",
    body: "Run the cleanup layer independently across wallet, explorer, or support surfaces.",
  },
  {
    title: "Integration-ready",
    body: "Expose account-state visibility where users already manage Stellar accounts.",
  },
];

const footerLinks = {
  product: [
    ["Inspect Account", "/app"],
    ["Close Account", "/app"],
    ["Docs", null],
  ],
  developers: [
    ["GitHub", "https://github.com/streamnft-tech/account_demolisher"],
    ["Integration Flow", null],
    ["Report issue", "https://github.com/streamnft-tech/account_demolisher/issues"],
  ],
};

function statusGlyph(status: ChecklistStatus): string {
  switch (status) {
    case "pass":
      return "✓";
    case "fail":
      return "✕";
    case "skipped":
      return "–";
    default:
      return "?";
  }
}

function loadWatchlist(): WatchlistEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is WatchlistEntry => {
      return (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as WatchlistEntry).accountId === "string" &&
        ((entry as WatchlistEntry).network === "mainnet" || (entry as WatchlistEntry).network === "testnet")
      );
    });
  } catch {
    return [];
  }
}

function formatAccount(accountId: string): string {
  if (accountId.length < 12) return accountId;
  return `${accountId.slice(0, 6)}…${accountId.slice(-6)}`;
}

function formatLastScanned(ts?: number): string {
  if (!ts) return "Not scanned";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(ts);
  } catch {
    return "Scanned";
  }
}

function useRouteMode(): RouteMode {
  const [mode, setMode] = useState<RouteMode>(() => (window.location.pathname.startsWith("/app") ? "app" : "landing"));

  useEffect(() => {
    const update = () => {
      setMode(window.location.pathname.startsWith("/app") ? "app" : "landing");
    };

    window.addEventListener("popstate", update);

    return () => {
      window.removeEventListener("popstate", update);
    };
  }, []);

  return mode;
}

function useScrolled() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return scrolled;
}

function fetchHealth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS) });
}

function devHealthLog(label: string, res: Response, text: string) {
  if (import.meta.env.DEV) {
    console.debug(`[health-fetch] ${label}`, {
      status: res.status,
      bytes: text.length,
      preview: text.slice(0, 240),
    });
  }
}

function NavLink({ href, children, muted = false }: { href: string; children: ReactNode; muted?: boolean }) {
  return (
    <a className={`navLink${muted ? " navLink--muted" : ""}`} href={href}>
      {children}
    </a>
  );
}

function SectionKicker({ children }: { children: ReactNode }) {
  return <div className="sectionKicker">{children}</div>;
}

function LedgerScene() {
  const nodes = [
    ["Trustlines", "12 active", "warn"],
    ["Allowances", "4 approvals", "warn"],
    ["Locked reserve", "1.8 XLM recoverable", "ok"],
    ["Open positions", "3 detected", "info"],
  ];

  return (
    <div className="ledgerScene" aria-hidden>
      <div className="ledgerOrbit ledgerOrbit--outer" />
      <div className="ledgerOrbit ledgerOrbit--inner" />
      <div className="ledgerCore">
        <strong>GABCD...WXYZ</strong>
        <span>Account Health</span>
        <em>Needs review</em>
      </div>
      <div className="ledgerNodes">
        {nodes.map(([label, value, tone], index) => (
          <div key={label} className={`ledgerNode ledgerNode--${tone}`} style={{ "--node-index": index } as CSSProperties}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="ledgerRail ledgerRail--one" />
      <div className="ledgerRail ledgerRail--two" />
    </div>
  );
}

function LandingPage() {
  const scrolled = useScrolled();
  const [heroAddress, setHeroAddress] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.title = "Stellar Sweep";
  }, []);

  const startScan = (rawAddress: string) => {
    const trimmed = rawAddress.trim();
    const target = trimmed ? `/app?account=${encodeURIComponent(trimmed)}` : "/app";
    window.location.href = target;
  };

  return (
    <div className="page">
      <header className={`topbar topbar--landing${scrolled ? " topbar--scrolled" : ""}`}>
        <div className="brand">
          <span className="brandMark" aria-hidden />
          <div>
            <div className="brandName">Stellar Sweep</div>
            <div className="brandTag">Account health for Stellar</div>
          </div>
        </div>
        <div className="nav nav--desktop nav--actions">
          <NavLink href="#docs" muted>
            Docs
          </NavLink>
          <NavLink href="/app">Scan Account</NavLink>
        </div>
        <div className="nav nav--mobile">
          <NavLink href="/app">Scan Account</NavLink>
          <button type="button" className="menuButton" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-controls="landing-mobile-menu">
            Menu
          </button>
          {menuOpen ? (
            <div className="mobileMenu" id="landing-mobile-menu">
              <NavLink href="#docs" muted>
                Docs
              </NavLink>
            </div>
          ) : null}
        </div>
      </header>

      <main className="landing">
        <section className="hero" id="scan">
          <div className="heroCopy">
            <SectionKicker>Non-custodial account health and cleanup for Stellar</SectionKicker>
            <h1>Clean up your Stellar account safely.</h1>
            <p className="heroText">
              Scan a public Stellar address to review trustlines, allowances, open positions, and locked reserves in
              one place before taking any cleanup or merge action. No signing required to scan.
            </p>
            <form
              className="heroSearch"
              onSubmit={(event) => {
                event.preventDefault();
                startScan(heroAddress);
              }}
            >
              <label className="srOnly" htmlFor="hero-address">
                Stellar account address
              </label>
              <input
                id="hero-address"
                className="heroInput"
                placeholder="Stellar account address"
                value={heroAddress}
                onChange={(event) => setHeroAddress(event.target.value)}
                spellCheck={false}
                autoCapitalize="none"
              />
              <div className="heroSearchActions">
                <button type="submit" className="btn primary heroSubmit">
                  Scan Account
                </button>
              </div>
            </form>
          </div>
          <LedgerScene />
        </section>

        <section className="infoGrid infoGrid--landing" id="problem">
          <article className="contentCard problemCopy">
            <SectionKicker>Problem</SectionKicker>
            <h2>Stellar accounts get stuck in hidden state.</h2>
            <p>
              A Stellar account can hold hidden state across assets, permissions, reserves, and DeFi activity. When
              users cannot see what is active or what must be resolved first, accounts get abandoned and recoverable
              value stays behind.
            </p>
          </article>
          <div className="problemReasons">
            {problemCards.map((card) => (
              <article key={card.title} className="problemReason">
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="stepsSection" id="how-it-works">
          <div className="sectionHeading">
            <SectionKicker>How it works</SectionKicker>
            <h2>Safely scan, clean, and close your account.</h2>
            <p>
              Stellar Sweep separates account inspection, cleanup, and final account closure so users never jump
              straight into irreversible actions.
            </p>
          </div>
          <div className="stepGrid">
            {[
              [
                "1",
                "Scan",
                "See active state, recoverable reserves, permissions, and blockers before approving any transaction.",
              ],
              [
                "2",
                "Review",
                "Understand which actions are required, which are optional, and which are irreversible.",
              ],
              [
                "3",
                "Clean",
                "Resolve account state through wallet-signed transactions, one reviewed action at a time.",
              ],
              [
                "4",
                "Close",
                "Close the account only after blockers are cleared, then route remaining funds to your chosen wallet or exchange destination.",
              ],
            ].map(([num, title, body]) => (
              <article key={title} className="stepCard">
                <div className="stepNumber">{num}</div>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="safetySection" id="safety">
          <article className="contentCard">
            <SectionKicker>Safety model</SectionKicker>
            <h2>
              Built to prevent blind signing
              <br />
              and irreversible mistakes.
            </h2>
            <p>
              Stellar Sweep separates scanning, cleanup, and account closure so users can inspect first, approve actions
              through their wallet, and avoid unsafe exits.
            </p>
            <div className="safetyPoints">
              {safetyCards.map((card) => (
                <div key={card.title} className={`safetyPoint${card.featured ? " safetyPoint--featured" : ""}`}>
                  <strong>{card.title}</strong>
                  <span>{card.body}</span>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="coverageSection" id="coverage">
          <div className="sectionHeading">
            <SectionKicker>Coverage</SectionKicker>
            <h2>Everything that can block a clean exit.</h2>
            <p>
              From trustlines and offers to allowances, reserves, and DeFi positions, Stellar Sweep helps surface the
              account state users need to review before cleanup.
            </p>
          </div>
          <div className="coverageGrid">
            {coverageGroups.map((group) => (
              <article key={group.title} className="coverageGroup">
                <h3>{group.title}</h3>
                <p>{group.body}</p>
                <ul>
                  {group.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="useCasesSection" id="for-teams">
          <div className="sectionHeading">
            <SectionKicker>Use cases</SectionKicker>
            <h2>One cleanup layer. Multiple ecosystem use cases.</h2>
            <p>
              From individual account health checks to wallet support flows, Stellar Sweep makes hidden account state
              easier to inspect and resolve.
            </p>
          </div>
          <div className="useCaseGrid">
            {useCaseCards.map((card) => (
              <article key={card.title} className="useCaseCard">
                <span>{card.benefit}</span>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="ecosystemSection">
          <div className="sectionHeading">
            <SectionKicker>Ecosystem infrastructure</SectionKicker>
            <h2>Account cleanup logic teams do not need to rebuild.</h2>
            <p>
              Wallets, exchanges, explorers, and support teams can integrate Stellar Sweep&apos;s account-state
              visibility and cleanup guidance instead of building custom flows from scratch.
            </p>
            <NavLink href="#docs">Built to integrate</NavLink>
          </div>
          <div className="ecosystemPoints">
            {ecosystemPoints.map((point) => (
              <article key={point.title} className="ecosystemPoint">
                <h3>{point.title}</h3>
                <p>{point.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="finalCta" id="docs">
          <SectionKicker>Start here</SectionKicker>
          <h2>Start with a scan. Decide what to clean later.</h2>
          <p>See the state of any Stellar account before signing, cleaning, or closing anything.</p>
          <form
            className="heroSearch heroSearch--final"
            onSubmit={(event) => {
              event.preventDefault();
              startScan(heroAddress);
            }}
          >
            <label className="srOnly" htmlFor="final-address">
              Stellar account address
            </label>
            <input
              id="final-address"
              className="heroInput"
              placeholder="Stellar account address"
              value={heroAddress}
              onChange={(event) => setHeroAddress(event.target.value)}
              spellCheck={false}
              autoCapitalize="none"
            />
            <div className="heroSearchActions">
              <button type="submit" className="btn primary heroSubmit">
                Scan Account
              </button>
            </div>
          </form>
        </section>

        <footer className="footer">
          <div className="footerGrid">
            <div className="footerBrand">
              <div className="footerBrandName">Stellar Sweep</div>
              <p>A non-custodial account health and cleanup tool for Stellar.</p>
            </div>

            <div className="footerColumn">
              <h3>Product</h3>
              {footerLinks.product.map(([label, href]) => (
                href ? (
                  <NavLink key={label} href={href}>
                    {label}
                  </NavLink>
                ) : (
                  <span key={label} className="footerPlaceholder">
                    {label}
                  </span>
                )
              ))}
            </div>

            <div className="footerColumn">
              <h3>Developers</h3>
              {footerLinks.developers.map(([label, href]) => (
                href ? (
                  <NavLink key={label} href={href} muted={href.startsWith("https://")}>
                    {label}
                  </NavLink>
                ) : (
                  <span key={label} className="footerPlaceholder">
                    {label}
                  </span>
                )
              ))}
            </div>
          </div>

          <div className="footerLegal">Stellar Sweep is non-custodial. Users review and approve cleanup actions through their own wallets.</div>
          <div className="footerBottom">© 2026 Stellar Sweep. Account health and cleanup infrastructure for Stellar.</div>
        </footer>
      </main>
    </div>
  );
}

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

function stateRowCopy(row: HealthChecklistItem | undefined): { value: string; detail: string; tone: string } {
  if (!row) {
    return { value: "Unable to verify", detail: "Requires rescan.", tone: "unknown" };
  }
  if (row.status === "pass") {
    return { value: "Clean", detail: row.detail ?? "No active state returned by the latest scan.", tone: "pass" };
  }
  if (row.status === "fail") {
    return { value: row.blocksDemolish ? "Needs cleanup" : "Needs review", detail: row.detail ?? "The latest scan returned active state.", tone: "fail" };
  }
  if (row.status === "skipped") {
    return { value: "Unable to verify", detail: row.detail ?? "This check was skipped by the current scan.", tone: "skipped" };
  }
  return { value: "Unable to verify", detail: row.detail ?? "Requires rescan or manual verification.", tone: "unknown" };
}

function scanRowCopy(label: string, row: HealthChecklistItem | undefined, health: HealthReport) {
  if (label === "Native XLM balance") {
    return {
      value: "Available",
      detail:
        typeof health.nativeBalanceXlm === "number"
          ? `${formatXlmCompact(health.nativeBalanceXlm)} available on this account.`
          : "Native balance was not returned by the latest scan.",
      tone: "pass",
    };
  }
  if (label === "Recoverable reserve") {
    return {
      value: "Available",
      detail: "Remaining native XLM can be sent to a destination when the account is closed.",
      tone: "pass",
    };
  }
  if (label === "Non-native balances") {
    return row?.status === "pass"
      ? { value: "Clean", detail: "No non-native balances detected in the latest scan.", tone: "pass" }
      : { value: "Needs cleanup", detail: "Non-native balances or trustline assets must be resolved before closing.", tone: "fail" };
  }
  if (label === "Estimated close payout") {
    return {
      value: "Estimated",
      detail: "Final payout is estimated after network fees and destination confirmation.",
      tone: "unknown",
    };
  }
  if (label === "Trustlines") {
    return row?.status === "pass"
      ? { value: "Clean", detail: "No removable trustlines found.", tone: "pass" }
      : { value: "Needs cleanup", detail: "Active trustlines must be removed before the account can close cleanly.", tone: "fail" };
  }
  if (label === "Open offers") {
    return row?.status === "pass"
      ? { value: "Clean", detail: "No open offers found.", tone: "pass" }
      : { value: "Needs cleanup", detail: "Open offers should be cancelled before removing related trustlines.", tone: "fail" };
  }
  if (label === "Extra signers") {
    return row?.status === "pass"
      ? { value: "Clean", detail: "No extra signers detected.", tone: "pass" }
      : { value: "Needs review", detail: "Extra signers may require additional approvals before cleanup or closure.", tone: "fail" };
  }
  if (label === "Thresholds") {
    return row?.status === "pass"
      ? { value: "Default", detail: "Default account thresholds detected.", tone: "pass" }
      : { value: "Needs review", detail: "Custom thresholds may require review before cleanup or closure.", tone: "fail" };
  }
  if (label === "Token allowances") {
    if (!row || row.status === "skipped" || row.status === "unknown") {
      return {
        value: "Unable to verify",
        detail: "Known spender contracts are not configured, so token allowances could not be fully checked.",
        tone: "unknown",
      };
    }
    return row.status === "pass"
      ? { value: "Clean", detail: "No active token allowances returned by the configured scan.", tone: "pass" }
      : { value: "Needs cleanup", detail: "Active token approvals may allow external spenders to move assets.", tone: "fail" };
  }
  if (label === "LP positions") {
    return row?.status === "pass"
      ? { value: "Clean", detail: "No LP positions detected.", tone: "pass" }
      : { value: "Needs cleanup", detail: "Liquidity pool positions should be closed before account closure.", tone: "fail" };
  }
  if (label === "DeFi positions") {
    return row?.status === "pass"
      ? { value: "Clean", detail: "No required DeFi blockers returned by the latest scan.", tone: "pass" }
      : { value: "Manual review", detail: "Some protocol checks require manual review before closing.", tone: "unknown" };
  }
  if (label === "Protocol surfaces") {
    return {
      value: "Manual review",
      detail: "Review protocol surfaces such as Blend, Aquarius, and Soroswap before closing.",
      tone: "unknown",
    };
  }
  if (label === "Claimable balances") {
    return row?.status === "pass"
      ? { value: "Clean", detail: "No pending claimable balances found.", tone: "pass" }
      : { value: "Available", detail: "Claimable balances can be claimed or skipped depending on cleanup goals.", tone: "fail" };
  }
  if (label === "Sponsorships") {
    return row?.status === "pass"
      ? { value: "Clean", detail: "No active sponsorship blockers found.", tone: "pass" }
      : { value: "Blocked", detail: "Active sponsorship relationships must be resolved before this account can close.", tone: "fail" };
  }
  if (label === "Destination") {
    return { value: "Not confirmed", detail: "Add and verify a destination before closing the account.", tone: "unknown" };
  }
  if (label === "Manual reviews") {
    return {
      value: "Manual review",
      detail: "Aquarius and Soroswap should be reviewed before closing.",
      tone: "unknown",
    };
  }
  if (label === "Close status") {
    return health.canDemolish
      ? {
          value: "Technically ready",
          detail: "No required blockers were detected, but manual protocol review is suggested before closing.",
          tone: "pass",
        }
      : stateRowCopy(row);
  }
  return stateRowCopy(row);
}

function formatXlmCompact(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unable to verify";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value) + " XLM";
}

function rowActionFor(
  row: HealthChecklistItem | undefined,
  opts: {
    walletConnected: boolean;
    onConnectWallet: () => void;
    onCloseStep: () => void;
    onResolveClassicBlocker: (code: BlockerCode) => void;
    walletBusy: boolean;
  },
): { label: string; disabled?: boolean; onClick?: () => void } {
  if (!row) return { label: "Unsupported", disabled: true };
  if (row.status === "pass") return { label: "No action needed", disabled: true };
  if (row.id === "native_merge_payout") return { label: "Review close step", onClick: opts.onCloseStep };
  if (row.id === "classic_min_reserve") return { label: "Set destination", onClick: opts.onCloseStep };
  if (row.id === "defi_positions") return { label: "Review manually" };
  if (row.id === "soroban_allowances") {
    if (row.status === "skipped" || row.status === "unknown") return { label: "Configure spenders" };
    return opts.walletConnected ? { label: "Revoke allowance" } : { label: "Connect Wallet", onClick: opts.onConnectWallet };
  }
  const blockerActions: Partial<Record<string, { code: BlockerCode; label: string }>> = {
    classic_open_offers: { code: "OPEN_OFFERS", label: "Cancel offers" },
    classic_claimable_balances: { code: "CLAIMABLE_BALANCES_PENDING", label: "Claim balance" },
    classic_sponsorship: { code: "SPONSORING_OTHER_ACCOUNTS", label: "Resolve sponsorship" },
    classic_data_entries: { code: "DATA_ENTRIES", label: "Remove data entries" },
    classic_extra_signers: { code: "MULTISIG_OR_EXTRA_SIGNERS", label: "Review signers" },
    classic_thresholds: { code: "NON_DEFAULT_THRESHOLDS", label: "Review thresholds" },
    classic_amm_lp_shares: { code: "OPEN_LIQUIDITY_POOL", label: "Close position" },
  };
  if (row.id === "classic_trustlines") {
    return opts.walletConnected ? { label: "Close trustline" } : { label: "Connect Wallet", onClick: opts.onConnectWallet };
  }
  const action = blockerActions[row.id];
  if (action) {
    if (!opts.walletConnected) return { label: "Connect Wallet", onClick: opts.onConnectWallet };
    return {
      label: action.label,
      disabled: opts.walletBusy,
      onClick: () => opts.onResolveClassicBlocker(action.code),
    };
  }
  if (row.status === "unknown" || row.status === "skipped") return { label: "Review manually" };
  return { label: "Unsupported", disabled: true };
}

function AccountStateDetails({
  health,
  checklist,
  walletConnected,
  walletBusy,
  onConnectWallet,
  onCloseStep,
  onResolveClassicBlocker,
}: {
  health: HealthReport;
  checklist: HealthChecklistItem[];
  walletConnected: boolean;
  walletBusy: boolean;
  onConnectWallet: () => void;
  onCloseStep: () => void;
  onResolveClassicBlocker: (code: BlockerCode) => void;
}) {
  const byId = new Map(checklist.map((row) => [row.id, row]));
  const groups = [
    {
      title: "Reserves and balances",
      rows: [
        ["Native XLM balance", byId.get("native_merge_payout")],
        ["Recoverable reserve", byId.get("classic_min_reserve")],
        ["Non-native balances", byId.get("classic_trustlines")],
        ["Estimated close payout", byId.get("native_merge_payout")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      title: "Trustlines and offers",
      rows: [
        ["Trustlines", byId.get("classic_trustlines")],
        ["Open offers", byId.get("classic_open_offers")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      title: "Permissions and signers",
      rows: [
        ["Extra signers", byId.get("classic_extra_signers")],
        ["Thresholds", byId.get("classic_thresholds")],
        ["Token allowances", byId.get("soroban_allowances")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      title: "Open positions",
      rows: [
        ["LP positions", byId.get("classic_amm_lp_shares")],
        ["DeFi positions", byId.get("defi_positions")],
        ["Protocol surfaces", byId.get("defi_positions")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      title: "Claimable balances",
      rows: [["Claimable balances", byId.get("classic_claimable_balances")]] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      title: "Sponsorships",
      rows: [["Sponsorships", byId.get("classic_sponsorship")]] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      title: "Close readiness",
      rows: [
        ["Destination", undefined],
        ["Manual reviews", byId.get("defi_positions")],
        ["Close status", byId.get("classic_min_reserve")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
  ];
  const protocols = health.openPositions?.defiProtocols ?? [];

  return (
    <section className="card consolePrimaryCard">
      <div className="sectionHeaderRow">
        <div>
          <h2 className="cardTitle">Actionable scan report</h2>
          <p className="hint">Open a category to review cleanup rows, technical details, and the next available action.</p>
        </div>
      </div>

      <div className="stateDetailGrid">
        {groups.map((group) => (
          <details key={group.title} className="stateDetailGroup">
            <summary className="stateDetailGroupSummary">
              <h3>{group.title}</h3>
              <span className="stateDetailGroupMeta">
                <span>
                  {group.rows.length} detail{group.rows.length === 1 ? "" : "s"}
                </span>
                <span className="stateDetailGroupChevron" aria-hidden>
                  ⌄
                </span>
              </span>
            </summary>
            <div className="stateDetailRows">
              {group.rows.map(([label, row]) => {
                const copy = scanRowCopy(label, row, health);
                const action =
                  label === "Destination"
                    ? { label: "Set destination", onClick: onCloseStep }
                    : label === "Recoverable reserve"
                      ? walletConnected
                        ? { label: "Set destination", onClick: onCloseStep }
                        : { label: "Connect Wallet", onClick: onConnectWallet }
                      : label === "Estimated close payout"
                        ? { label: "Review close step", onClick: onCloseStep }
                        : label === "Native XLM balance"
                          ? { label: "No action needed", disabled: true }
                          : label === "Close status"
                            ? walletConnected
                              ? { label: "Continue to close", onClick: onCloseStep }
                              : { label: "Connect Wallet", onClick: onConnectWallet }
                            : rowActionFor(row, {
                                walletConnected,
                                walletBusy,
                                onConnectWallet,
                                onCloseStep,
                                onResolveClassicBlocker,
                              });
                return (
                  <details key={label} className="scanReportRow">
                    <summary>
                      <div className="scanReportMain">
                        <span>{label}</span>
                        <p>{copy.detail}</p>
                      </div>
                      <strong className={`stateValue stateValue--${copy.tone}`}>{copy.value}</strong>
                      <button
                        type="button"
                        className={action.disabled ? "btn ghost scanReportAction" : "btn secondary scanReportAction"}
                        disabled={action.disabled}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          action.onClick?.();
                        }}
                      >
                        {action.label}
                      </button>
                    </summary>
                    <div className="scanReportDetails">
                      <p>{row?.detail ?? copy.detail}</p>
                      {row ? (
                        <dl>
                          <div>
                            <dt>Status</dt>
                            <dd>{outcomeLabel(row)}</dd>
                          </div>
                          <div>
                            <dt>Blocks close</dt>
                            <dd>{row.blocksDemolish ? "Yes" : "No"}</dd>
                          </div>
                          <div>
                            <dt>Check ID</dt>
                            <dd>{row.id}</dd>
                          </div>
                        </dl>
                      ) : null}
                      {label === "Native XLM balance" && typeof health.nativeBalanceXlm === "number" ? (
                        <p className="monoDetail">Full precision: {health.nativeBalanceXlm.toFixed(7)} XLM</p>
                      ) : null}
                    </div>
                  </details>
                );
              })}
            </div>
          </details>
        ))}
      </div>

      {protocols.length > 0 ? (
        <div className="protocolList">
          <h3>Protocol surfaces</h3>
          {protocols.map((protocol) => (
            <article key={protocol.id} className="protocolRow">
              <div>
                <strong>{protocol.label}</strong>
                <p>{protocol.detail}</p>
              </div>
              <span className={`stateValue stateValue--${protocol.status}`}>
                {protocol.status === "pass" ? "Passed" : protocol.status === "fail" ? "Needs review" : "Manual review"}
              </span>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AppShell() {
  const [activeSection, setActiveSection] = useState<AppSection>("scan");
  const [network, setNetwork] = useState<UiNetwork>("testnet");
  const [source, setSource] = useState(() => new URLSearchParams(window.location.search).get("account") ?? "");
  const [destination, setDestination] = useState("");
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [, setActionSuccess] = useState<string | null>(null);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>(() => loadWatchlist());
  const [watchlistDraft, setWatchlistDraft] = useState("");
  const [watchlistNetwork, setWatchlistNetwork] = useState<UiNetwork>("testnet");
  const [closeConfirm, setCloseConfirm] = useState("");
  const [didAutoloadQueryAccount, setDidAutoloadQueryAccount] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);

  useEffect(() => {
    void ensureWalletKit(network);
  }, [network]);

  const connectWallet = useCallback(async () => {
    setWalletError(null);
    setWalletBusy(true);
    try {
      const { address } = await connectWalletWithKit(network);
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
      await disconnectWalletFromKit(network);
      setWalletAddress(null);
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  }, [network]);

  const openWalletProfile = useCallback(async () => {
    setWalletError(null);
    setWalletBusy(true);
    try {
      const { address } = await connectWalletWithKit(network);
      setWalletAddress(address);
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  }, [network]);

  useEffect(() => {
    document.title = "Stellar Sweep | App";
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlist));
  }, [watchlist]);

  const scanAccount = useCallback(
    async (accountId: string, targetNetwork: UiNetwork, opts?: { syncInputs?: boolean }) => {
      const trimmed = accountId.trim();
      if (opts?.syncInputs) {
        setSource(trimmed);
        setNetwork(targetNetwork);
      }
      setError(null);
      setHealth(null);
      setActionSuccess(null);
      if (!isValidClassicAddress(trimmed)) {
        setError("Enter a valid classic G-address (56 chars).");
        return null;
      }
      setLoading(true);
      try {
        const q = new URLSearchParams({ network: targetNetwork });
        const res = await fetchHealth(`/api/account/${encodeURIComponent(trimmed)}/health?${q}`);
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
        setLastScannedAt(Date.now());
        return report;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Health check failed");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const runHealthCheck = useCallback(async () => {
    await scanAccount(source.trim(), network);
  }, [source, network, scanAccount]);

  const resetOverview = useCallback(() => {
    setSource("");
    setHealth(null);
    setError(null);
    setActionSuccess(null);
    setLastScannedAt(null);
    setDestination("");
    setCloseConfirm("");
  }, []);

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
      const signed = await signWithWallet(network, batch.xdr, {
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

  const runAccountMerge = useCallback(async () => {
    const id = source.trim();
    const dest = destination.trim();
    if (!health?.horizonUrl || !walletAddress || !isValidClassicAddress(id) || !isValidClassicAddress(dest)) return;
    if (!health.canDemolish) {
      setWalletError("Health scan must report merge-ready state before submitting ACCOUNT_MERGE.");
      return;
    }
    if (id === dest) {
      setWalletError("Destination must differ from the source account.");
      return;
    }
    setMergeBusy(true);
    setWalletError(null);
    setActionSuccess(null);
    try {
      const batch = await buildAccountMergeBatchXdr({
        horizonUrl: health.horizonUrl,
        sourceAccount: id,
        destinationAccount: dest,
        network,
      });
      const { hash } = await signSubmitClassicBatch(batch);
      setActionSuccess(
        `Account merge submitted. Tx ${hash.slice(0, 10)}… Native XLM (minus fee) credits the destination; this account should disappear once Horizon confirms.`,
      );
      await refreshHealth();
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setMergeBusy(false);
    }
  }, [health, network, source, destination, walletAddress, refreshHealth, signSubmitClassicBatch]);

  const destOk = isValidClassicAddress(destination.trim());
  const blocking = health?.blockers.filter((b: Blocker) => b.kind === "blocking") ?? [];
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
  const isSaved = watchlist.some((entry) => entry.accountId === sourceTrim && entry.network === network);
  const readyByHealth = health?.canDemolish === true;
  const checklistById = new Map(checklist.map((row) => [row.id, row]));
  const protocolReviewCount =
    health?.openPositions?.defiProtocols.filter((protocol) => protocol.status === "unknown" || protocol.status === "fail").length ?? 0;
  const openPositionCount =
    (health?.openPositions?.liquidityPoolShares.length ?? 0) + (health?.openPositions?.sdexOffers.length ?? 0);
  const accountStatusLabel = !health ? "Requires scan" : health.canDemolish ? "Technically ready" : blocking.length > 0 ? "Needs cleanup" : "Needs review";
  const trustlinesLabel = checklistById.get("classic_trustlines")?.status === "pass" ? "0 active" : checklistById.get("classic_trustlines") ? "Active" : "Unable to verify";
  const priorityFindings = health
    ? [
        blocking.length === 0
          ? ["No required blockers found", "Classic account checks did not return active blockers."]
          : [`${blocking.length} blocker${blocking.length === 1 ? "" : "s"} found`, blocking[0]?.description ?? "Review required cleanup rows."],
        protocolReviewCount > 0
          ? ["Manual protocol review suggested", `${protocolReviewCount} protocol check${protocolReviewCount === 1 ? "" : "s"} should be reviewed before closing.`]
          : ["No protocol blockers returned", "The current protocol scan did not return blocking DeFi positions."],
        checklistById.get("soroban_allowances")?.status === "skipped" || checklistById.get("soroban_allowances")?.status === "unknown"
          ? ["Allowances not fully verified", "Configure known spender contracts to verify token allowances."]
          : ["Allowances checked", "The configured allowance checks did not return active approvals."],
        ["Destination not confirmed", "Add a destination before closing the account."],
      ]
    : [];

  useEffect(() => {
    if (!health || !sourceTrim) return;
    setWatchlist((prev) =>
      prev.map((entry) =>
        entry.accountId === sourceTrim && entry.network === network
          ? {
              ...entry,
              summary: health.summary,
              blockersCount: health.blockers.filter((b) => b.kind === "blocking").length,
              readyToClose: health.canDemolish,
              nativeBalanceXlm: health.nativeBalanceXlm,
              lastScannedAt: lastScannedAt ?? Date.now(),
            }
          : entry,
      ),
    );
  }, [health, sourceTrim, network, lastScannedAt]);

  const saveAccountToWatchlist = useCallback(
    (accountId: string, targetNetwork: UiNetwork, report?: HealthReport | null) => {
      const trimmed = accountId.trim();
      if (!isValidClassicAddress(trimmed)) {
        setError("Enter a valid classic G-address before saving.");
        return;
      }
      const now = Date.now();
      setWatchlist((prev) => {
        const nextEntry: WatchlistEntry = {
          accountId: trimmed,
          network: targetNetwork,
          savedAt: prev.find((entry) => entry.accountId === trimmed && entry.network === targetNetwork)?.savedAt ?? now,
          lastScannedAt: report ? now : prev.find((entry) => entry.accountId === trimmed && entry.network === targetNetwork)?.lastScannedAt,
          summary: report?.summary ?? prev.find((entry) => entry.accountId === trimmed && entry.network === targetNetwork)?.summary,
          blockersCount:
            report?.blockers.filter((b) => b.kind === "blocking").length ??
            prev.find((entry) => entry.accountId === trimmed && entry.network === targetNetwork)?.blockersCount,
          readyToClose:
            report?.canDemolish ?? prev.find((entry) => entry.accountId === trimmed && entry.network === targetNetwork)?.readyToClose,
          nativeBalanceXlm:
            report?.nativeBalanceXlm ?? prev.find((entry) => entry.accountId === trimmed && entry.network === targetNetwork)?.nativeBalanceXlm,
        };

        const filtered = prev.filter((entry) => !(entry.accountId === trimmed && entry.network === targetNetwork));
        return [nextEntry, ...filtered];
      });
    },
    [],
  );

  const removeFromWatchlist = useCallback((accountId: string, targetNetwork: UiNetwork) => {
    setWatchlist((prev) => prev.filter((entry) => !(entry.accountId === accountId && entry.network === targetNetwork)));
  }, []);

  const selectWatchlistAccount = useCallback((entry: WatchlistEntry, targetSection: AppSection = "scan") => {
    setSource(entry.accountId);
    setNetwork(entry.network);
    setActiveSection(targetSection);
  }, []);

  useEffect(() => {
    if (didAutoloadQueryAccount) return;
    setDidAutoloadQueryAccount(true);
    if (!isValidClassicAddress(sourceTrim)) return;
    void scanAccount(sourceTrim, network);
  }, [didAutoloadQueryAccount, network, scanAccount, sourceTrim]);

  const scanStatus = health ? "Latest scan" : "Ready";
  const healthStatus = sourceTrim ? (isSaved ? "Saved" : "Save account") : "Saved accounts";
  const closeStatus = !sourceTrim || !health ? "Locked" : readyByHealth ? "Ready" : "Locked";

  return (
    <div className="page page--app">
      <main className="workspace">
        <section className="consoleShell">
          <aside className="consoleSidebar">
            <div className="consoleSidebarTop">
              <div className="brand">
                <span className="brandMark" aria-hidden />
                <div>
                  <div className="brandName">Stellar Sweep</div>
                  <div className="brandTag">Account cleanup console</div>
                </div>
              </div>
            </div>

            <nav className="sidebarNav" aria-label="App navigation">
              {[
                ["scan", "Scan", scanStatus],
                ["health", "Health", healthStatus],
                ["close", "Close Account", closeStatus],
              ].map(([id, label, detail]) => (
                <button
                  key={id}
                  type="button"
                  className={`sidebarNavButton${activeSection === id ? " sidebarNavButton--active" : ""}`}
                  onClick={() => setActiveSection(id as AppSection)}
                >
                  <span className="sidebarNavLabel">{label}</span>
                  <span className="sidebarNavMeta">{detail}</span>
                </button>
              ))}
            </nav>
          </aside>

          <section className="consoleContent">
            <div className="consoleTopbar">
              <div className="consoleTopbarSpacer" aria-hidden />
              <div className="consoleTopbarActions">
                {walletAddress ? (
                  <>
                    <div className="topbarWalletState">
                      <span>Wallet:</span>
                      <strong>{formatAccount(walletAddress)}</strong>
                    </div>
                    <button type="button" className="btn secondary" disabled={walletBusy} onClick={openWalletProfile}>
                      Switch Wallet
                    </button>
                    <button type="button" className="btn ghost" disabled={walletBusy} onClick={disconnectWallet}>
                      Disconnect
                    </button>
                  </>
                ) : (
                  <>
                    <div className="topbarWalletState">
                      <span>Wallet:</span>
                      <strong>Not connected</strong>
                    </div>
                    <button type="button" className="btn secondary" disabled={walletBusy} onClick={connectWallet}>
                      {walletBusy ? "Opening…" : "Connect Wallet"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {activeSection === "scan" ? (
              <>
                <div className="pageIntro pageHeader pageHeader--simple">
                  <div className="pageHeaderCopy">
                    <SectionKicker>Scan</SectionKicker>
                    <h1>Check account health before cleanup.</h1>
                    <p>
                      Enter a Stellar address to scan reserves, trustlines, permissions, positions, and close readiness.
                      No signing required.
                    </p>
                    <div className="trustChipRow" aria-label="Scan safety">
                      <span>Read-only scan</span>
                      <span>No wallet signature</span>
                      <span>Cleanup approval later</span>
                    </div>
                  </div>
                </div>

                <section className="scanWorkspace">
                  <div className="card consolePrimaryCard scanFormCard">
                    <div>
                      <h2 className="cardTitle">Scan account</h2>
                      <p className="hint">Start with a public address. Cleanup actions require wallet approval later.</p>
                    </div>

                    <div className="overviewControls">
                      <div className="overviewControlBlock">
                        <label className="label" htmlFor="source">
                          Stellar address
                        </label>
                        <input
                          id="source"
                          className="input"
                          placeholder="G..."
                          value={source}
                          onChange={(e) => {
                            setSource(e.target.value);
                            setHealth(null);
                            setActionSuccess(null);
                          }}
                          spellCheck={false}
                          autoCapitalize="none"
                        />
                      </div>
                      <div className="overviewControlBlock">
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
                      </div>
                    </div>

                    <div className="sectionActions">
                      <button type="button" className="btn primary scanSubmit" disabled={loading} onClick={runHealthCheck}>
                        {loading ? "Scanning…" : "Scan Account"}
                      </button>
                    </div>

                    <p className="meta">Scanning is read-only. Wallet approval is only needed for cleanup actions.</p>
                    {walletError ? <p className="error">{walletError}</p> : null}
                    {error ? <p className="error">{error}</p> : null}
                    {walletMismatch ? (
                      <p className="error">
                        Connected wallet <code className="inlineCode">{walletAddress?.slice(0, 8)}…</code> does not match
                        the selected account. Cleanup actions require the account owner wallet.
                      </p>
                    ) : null}
                  </div>

                  <aside className="scanInfoStack">
                    <article className="card consolePrimaryCard scanInfoCard">
                      <h2 className="cardTitle">What the scan checks</h2>
                      <ul className="scanCheckList">
                        {["Recoverable XLM", "Trustlines and offers", "Permissions and signers", "Open positions", "Close readiness"].map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </article>
                    <article className="card consolePrimaryCard scanInfoCard">
                      <h2 className="cardTitle">Non-custodial by design</h2>
                      <p className="hint">
                        Stellar Sweep never needs your private key to scan. Actions are reviewed separately and signed
                        through your wallet.
                      </p>
                    </article>
                    {!health ? (
                      <article className="card consolePrimaryCard scanInfoCard scanEmptyState">
                        <h2 className="cardTitle">Ready when you are.</h2>
                        <p className="hint">Run a read-only scan to see account state, cleanup blockers, and recoverable XLM.</p>
                      </article>
                    ) : null}
                  </aside>
                </section>

                {health ? (
                  <section className="card consolePrimaryCard">
                    <div className="sectionHeaderRow">
                      <div>
                        <h2 className="cardTitle">Latest scan</h2>
                        <p className={`summary ${health.canDemolish ? "ok" : "warn"}`}>{health.summary}</p>
                      </div>
                    </div>

                    <div className="summaryGrid">
                      <div className="summaryCard">
                        <span>Account status</span>
                        <strong>{accountStatusLabel}</strong>
                      </div>
                      <div className="summaryCard">
                        <span>Recoverable XLM</span>
                        <strong>{formatXlmCompact(health.nativeBalanceXlm)}</strong>
                      </div>
                      <div className="summaryCard">
                        <span>Trustlines</span>
                        <strong>{trustlinesLabel}</strong>
                      </div>
                      <div className="summaryCard">
                        <span>Open positions</span>
                        <strong>{openPositionCount} detected</strong>
                      </div>
                      <div className="summaryCard">
                        <span>Manual review</span>
                        <strong>{protocolReviewCount} protocol check{protocolReviewCount === 1 ? "" : "s"}</strong>
                      </div>
                    </div>

                    <div className="priorityFindings">
                      <h3>Priority findings</h3>
                      <div className="priorityFindingGrid">
                        {priorityFindings.map(([title, body]) => (
                          <article key={title} className="priorityFinding">
                            <strong>{title}</strong>
                            <p>{body}</p>
                          </article>
                        ))}
                      </div>
                    </div>

                    <div className="sectionActions">
                      <button type="button" className="btn primary" onClick={() => setActiveSection("close")}>
                        Review close step
                      </button>
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() => saveAccountToWatchlist(sourceTrim, network, health)}
                      >
                        {isSaved ? "Saved to Health" : "Save to Health"}
                      </button>
                      <button type="button" className="btn secondary" onClick={resetOverview}>
                        Scan another account
                      </button>
                    </div>
                  </section>
                ) : null}

                {health ? (
                  <AccountStateDetails
                    health={health}
                    checklist={checklist}
                    walletConnected={Boolean(walletAddress)}
                    walletBusy={walletBusy}
                    onConnectWallet={connectWallet}
                    onCloseStep={() => setActiveSection("close")}
                    onResolveClassicBlocker={(code) => {
                      void resolveClassicBlocker(code);
                    }}
                  />
                ) : null}

                {showTrustlineTeardown && health?.horizonUrl ? (
                  <TrustlineTeardownCard
                    accountId={sourceTrim}
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

                {health ? (
                  <details className="card consolePrimaryCard technicalDetails">
                    <summary>
                      <span>Technical details</span>
                      <strong>{checklist.length} scan checks</strong>
                    </summary>
                    <ul className="checklistList">
                      {checklist.map((row) => (
                        <li
                          key={row.id}
                          className={`checklistRow status-${row.status}`}
                          aria-label={`${row.label}: ${outcomeLabel(row)}`}
                        >
                          <span className="checklistBadge" aria-hidden>
                            {statusGlyph(row.status)}
                          </span>
                          <div className="checklistBody">
                            <div className="checklistLabelRow">
                              <span className="checklistLabel">{row.label}</span>
                              <span className={outcomePillClass(row)}>{outcomeLabel(row)}</span>
                            </div>
                            {row.detail ? <p className="checklistDetail">{row.detail}</p> : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            ) : null}

            {activeSection === "health" ? (
              <>
                <div className="pageIntro pageHeader">
                  <div className="pageHeaderCopy">
                    <SectionKicker>Health</SectionKicker>
                    <h1>Health</h1>
                    <p>
                      Save Stellar addresses you want to monitor for cleanup readiness, permissions, recoverable reserves,
                      or future close actions.
                    </p>
                  </div>
                  <div className="pageHeaderStatus">
                    <span>Saved accounts</span>
                    <strong>{watchlist.length}</strong>
                    <small>{sourceTrim ? `Current: ${formatAccount(sourceTrim)}` : "Scan first, save later"}</small>
                  </div>
                </div>

                <section className="card consolePrimaryCard">
                  <div className="watchlistAddRow">
                    <div className="overviewControlBlock">
                      <label className="label" htmlFor="watchlist-account">
                        Add account
                      </label>
                      <input
                        id="watchlist-account"
                        className="input"
                        placeholder="G…"
                        value={watchlistDraft}
                        onChange={(e) => setWatchlistDraft(e.target.value)}
                        spellCheck={false}
                        autoCapitalize="none"
                      />
                    </div>
                    <div className="overviewControlBlock">
                      <div className="label">Network</div>
                      <div className="segmented" role="group" aria-label="Health account network">
                        <button
                          type="button"
                          className={`seg ${watchlistNetwork === "testnet" ? "active" : ""}`}
                          onClick={() => setWatchlistNetwork("testnet")}
                        >
                          Testnet
                        </button>
                        <button
                          type="button"
                          className={`seg ${watchlistNetwork === "mainnet" ? "active" : ""}`}
                          onClick={() => setWatchlistNetwork("mainnet")}
                        >
                          Mainnet
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="sectionActions">
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => saveAccountToWatchlist(watchlistDraft, watchlistNetwork)}
                      disabled={!isValidClassicAddress(watchlistDraft.trim())}
                    >
                      Save current account
                    </button>
                    <button type="button" className="btn secondary" onClick={() => setActiveSection("scan")}>
                      Scan an account
                    </button>
                  </div>
                </section>

                {watchlist.length === 0 ? (
                  <section className="card consolePrimaryCard emptyStateCard">
                    <h2 className="cardTitle">No saved accounts yet.</h2>
                    <p className="hint">Scan an address and save it to track account health over time.</p>
                    <div className="sectionActions">
                      <button type="button" className="btn primary" onClick={() => saveAccountToWatchlist(watchlistDraft, watchlistNetwork)} disabled={!isValidClassicAddress(watchlistDraft.trim())}>
                        Save current account
                      </button>
                      <button type="button" className="btn secondary" onClick={() => setActiveSection("scan")}>
                        Scan an account
                      </button>
                    </div>
                  </section>
                ) : (
                  <section className="watchlistList">
                    {watchlist.map((entry) => (
                      <article key={`${entry.network}:${entry.accountId}`} className="card watchlistItem">
                        <div className="sectionHeaderRow">
                          <div>
                            <h2 className="cardTitle">{formatAccount(entry.accountId)}</h2>
                            <p className="meta">
                              {entry.network === "mainnet" ? "Mainnet" : "Testnet"} · {entry.summary ?? "Requires rescan"}
                            </p>
                          </div>
                          <span
                            className={`statusBadge${
                              entry.readyToClose ? " statusBadge--ok" : entry.blockersCount ? " statusBadge--warn" : ""
                            }`}
                          >
                            {entry.readyToClose
                              ? "Technically ready"
                              : typeof entry.blockersCount === "number"
                                ? `${entry.blockersCount} blocker${entry.blockersCount === 1 ? "" : "s"}`
                                : "Not scanned"}
                          </span>
                        </div>
                        <div className="watchlistMetaRow">
                          <span>Network: {entry.network === "mainnet" ? "Mainnet" : "Testnet"}</span>
                          <span>Last scanned: {formatLastScanned(entry.lastScannedAt)}</span>
                          <span>
                            Recoverable XLM:{" "}
                            {typeof entry.nativeBalanceXlm === "number"
                              ? formatXlmCompact(entry.nativeBalanceXlm)
                              : "Not available"}
                          </span>
                          <span>Manual review: {entry.readyToClose ? "Protocol review suggested" : "Requires scan"}</span>
                        </div>
                        <div className="sectionActions">
                          <button type="button" className="btn secondary" onClick={() => selectWatchlistAccount(entry)}>
                            Select account
                          </button>
                          <button
                            type="button"
                            className="btn secondary"
                            disabled={loading}
                            onClick={() => {
                              setActiveSection("scan");
                              void scanAccount(entry.accountId, entry.network, { syncInputs: true });
                            }}
                          >
                            Rescan account
                          </button>
                          <button
                            type="button"
                            className="btn primary"
                            onClick={() => {
                              selectWatchlistAccount(entry, "scan");
                              if (!health || sourceTrim !== entry.accountId || network !== entry.network) {
                                void scanAccount(entry.accountId, entry.network, { syncInputs: true });
                              }
                            }}
                          >
                            View scan
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => removeFromWatchlist(entry.accountId, entry.network)}
                          >
                            Remove account
                          </button>
                        </div>
                      </article>
                    ))}
                  </section>
                )}
              </>
            ) : null}

            {activeSection === "close" ? (
              <>
                <div className="pageIntro pageHeader">
                  <div className="pageHeaderCopy">
                    <SectionKicker>Close Account</SectionKicker>
                    <h1>{sourceTrim ? "Close Account" : "Select an account to close."}</h1>
                    <p>
                      {sourceTrim
                        ? "Close this Stellar account only after reviewing blockers, protocol surfaces, and destination details."
                        : "Scan an account or choose one from Health before starting the final close flow."}
                    </p>
                  </div>
                  <div className="pageHeaderStatus">
                    <span>Close state</span>
                    <strong>{!sourceTrim || !health ? "Locked" : readyByHealth ? "Ready" : "Blocked"}</strong>
                    <small>{sourceTrim ? formatAccount(sourceTrim) : "No account selected"}</small>
                  </div>
                </div>

                {!sourceTrim ? (
                  <section className="card consolePrimaryCard emptyStateCard">
                    <div className="sectionActions">
                      <button type="button" className="btn primary" onClick={() => setActiveSection("scan")}>
                        Go to Scan
                      </button>
                      <button type="button" className="btn secondary" onClick={() => setActiveSection("health")}>
                        Open Health
                      </button>
                    </div>
                  </section>
                ) : !health ? (
                  <section className="card consolePrimaryCard emptyStateCard">
                    <h2 className="cardTitle">Requires scan</h2>
                    <p className="hint">Run a scan first so close readiness and blockers can be verified.</p>
                    <div className="sectionActions">
                      <button type="button" className="btn primary" onClick={() => setActiveSection("scan")}>
                        Go to Scan
                      </button>
                      <button type="button" className="btn secondary" disabled={loading} onClick={runHealthCheck}>
                        {loading ? "Scanning…" : "Scan selected account"}
                      </button>
                    </div>
                  </section>
                ) : !readyByHealth ? (
                  <section className="card consolePrimaryCard">
                    <div className="sectionHeaderRow">
                      <div>
                        <h2 className="cardTitle">This account is not ready to close yet.</h2>
                        <p className="hint">Resolve required rows in Scan before final account close becomes available.</p>
                      </div>
                      <span className="statusBadge statusBadge--warn">Locked</span>
                    </div>
                    {blocking.length > 0 ? (
                      <div className="actionList">
                        {blocking.map((blocker) => (
                          <article key={blocker.code} className="actionCard">
                            <h3>{blocker.title}</h3>
                            <p>{blocker.description}</p>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="meta">Unable to verify close readiness. Requires rescan.</p>
                    )}
                    <div className="sectionActions">
                      <button type="button" className="btn primary" onClick={() => setActiveSection("scan")}>
                        Return to Scan
                      </button>
                    </div>
                  </section>
                ) : (
                  <>
                    {!walletAddress ? (
                      <section className="card consolePrimaryCard">
                        <h2 className="cardTitle">Connect wallet to continue.</h2>
                        <p className="hint">
                          Close execution requires wallet approval from the selected account owner.
                        </p>
                        <div className="sectionActions">
                          <button type="button" className="btn primary" disabled={walletBusy} onClick={connectWallet}>
                            {walletBusy ? "Opening…" : "Connect Wallet"}
                          </button>
                        </div>
                      </section>
                    ) : null}

                    <section className="card consolePrimaryCard">
                      <div className="sectionHeaderRow">
                        <div>
                          <h2 className="cardTitle">Final close review</h2>
                          <p className="summary ok">Technically ready · Manual protocol review suggested</p>
                        </div>
                        <span className="statusBadge statusBadge--ok">Technically ready</span>
                      </div>

                      <label className="label" htmlFor="dest">
                        Destination Stellar address
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

                      <div className="summaryGrid">
                        <div className="summaryCard">
                          <span>Selected account</span>
                          <strong>{formatAccount(sourceTrim)}</strong>
                        </div>
                        <div className="summaryCard">
                          <span>Close readiness</span>
                          <strong>{health.canDemolish ? "Technically ready" : "Requires review"}</strong>
                        </div>
                        <div className="summaryCard">
                          <span>Final payout estimate</span>
                          <strong>{formatXlmCompact(health.nativeBalanceXlm)}</strong>
                        </div>
                        <div className="summaryCard">
                          <span>Destination</span>
                          <strong>{destination.trim() ? formatAccount(destination.trim()) : "Not provided"}</strong>
                        </div>
                      </div>

                      <div className="closeWarning">
                        <strong>Closing an account is irreversible.</strong>
                        <p>
                          Remaining native XLM will be sent to the destination address. Non-native assets must be
                          resolved before closing.
                        </p>
                      </div>

                      <label className="label" htmlFor="close-confirm">
                        Type CLOSE to continue
                      </label>
                      <input
                        id="close-confirm"
                        className="input"
                        value={closeConfirm}
                        onChange={(e) => setCloseConfirm(e.target.value)}
                        spellCheck={false}
                        autoCapitalize="characters"
                      />

                      <div className="sectionActions">
                        <button
                          type="button"
                          className="btn danger"
                          disabled={!destOk || closeConfirm !== "CLOSE" || !walletAddress || walletBusy || mergeBusy || Boolean(walletMismatch) || !health.horizonUrl}
                          title="Sign final close in your wallet. This action is irreversible once confirmed on-chain."
                          onClick={() => void runAccountMerge()}
                        >
                          {mergeBusy ? "Closing account…" : "Close Account"}
                        </button>
                      </div>
                      {walletError ? <p className="error">{walletError}</p> : null}
                    </section>
                  </>
                )}
              </>
            ) : null}
          </section>
        </section>
      </main>
    </div>
  );
}

export function App() {
  const route = useRouteMode();
  return route === "app" ? <AppShell /> : <LandingPage />;
}
