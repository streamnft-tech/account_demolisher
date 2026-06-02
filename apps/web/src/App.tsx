import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Blocker, BlockerCode, ChecklistStatus, HealthChecklistItem, HealthReport } from "@stellar/core";
import { isValidClassicAddress } from "@stellar/core";
import type { UiNetwork } from "./network.js";
import {
  connectWallet as connectWalletWithKit,
  disconnectWallet as disconnectWalletFromKit,
  ensureWalletKit,
  formatWalletError,
  openWalletProfile as openWalletProfileWithKit,
  signWithWallet,
} from "./walletKit.js";
import { runClassicBlockerFix } from "./classicBlockerHandlers.js";
import type { ClassicBatchResult } from "./classicClose.js";
import { sdkPassphrase, submitSignedClassicTx } from "./classicClose.js";
import { buildAccountMergeBatchXdr } from "./classicDemolish.js";
import { TrustlineTeardownCard, type TrustlineCleanupSummary } from "./TrustlineTeardownCard.js";
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

const BASE_RESERVE_XLM = 0.5;

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
    body: "Secret keys and signing authority never move to Orbitway servers.",
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

const scanChecklistLabels = [
  "Estimated reserve release",
  "Trustline cleanup",
  "Permission review",
  "Manual protocol review",
  "Close readiness",
];

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
    document.title = "Orbitway";
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
          <img className="brandMark" src="/orbitway-logo.png" alt="" />
          <div>
            <div className="brandName">Orbitway</div>
            <div className="brandTag">Account health and cleanup</div>
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
              Orbitway separates account inspection, cleanup, and final account closure so users never jump
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
              Orbitway separates scanning, cleanup, and account closure so users can inspect first, approve actions
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
              From trustlines and offers to allowances, reserves, and DeFi positions, Orbitway helps surface the
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
              From individual account health checks to wallet support flows, Orbitway makes hidden account state
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
              Wallets, exchanges, explorers, and support teams can integrate Orbitway&apos;s account-state
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
              <div className="footerBrandName">Orbitway</div>
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

          <div className="footerLegal">Orbitway is non-custodial. Users review and approve cleanup actions through their own wallets.</div>
          <div className="footerBottom">© 2026 Orbitway. Account health and cleanup infrastructure for Stellar.</div>
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
  if (label === "Estimated reserve release") {
    return row?.status === "pass"
      ? { value: "Ready", detail: "Reserve tied to removable trustlines is no longer blocked.", tone: "pass" }
      : {
          value: "Locked value",
          detail: "Token lines still hold reserve. Review the trustline planner to release it safely.",
          tone: "fail",
        };
  }
  if (label === "Claimable balances") {
    return row?.status === "pass"
      ? { value: "None", detail: "No claimable balances were returned by the latest scan.", tone: "pass" }
      : { value: "Available", detail: "These balances are claimable to the account and are separate from reserve release.", tone: "fail" };
  }
  if (label === "Token-line cleanup opportunities") {
    return row?.status === "pass"
      ? { value: "Clear", detail: "No token lines need cleanup before close.", tone: "pass" }
      : {
          value: "Review token lines",
          detail: "Each token line can be handled individually so you can unlock value without guesswork.",
          tone: "fail",
        };
  }
  if (label === "Trustlines") {
    return row?.status === "pass"
      ? { value: "Clear", detail: "No removable trustlines were detected.", tone: "pass" }
      : { value: "Needs cleanup", detail: "Trustlines must be resolved before the account can close cleanly.", tone: "fail" };
  }
  if (label === "Sponsorships") {
    return row?.status === "pass"
      ? { value: "None", detail: "No sponsorship relationships are blocking the account.", tone: "pass" }
      : { value: "Blocked", detail: "Sponsored reserves must be cleared before final close.", tone: "fail" };
  }
  if (label === "Open activity") {
    return row?.status === "pass"
      ? { value: "Clear", detail: "No open offers or liquidity positions remain.", tone: "pass" }
      : { value: "Needs cleanup", detail: "Open offers or positions may still block cleanup or close.", tone: "fail" };
  }
  if (label === "LP positions") {
    return row?.status === "pass"
      ? { value: "Clear", detail: "No liquidity pool positions were returned.", tone: "pass" }
      : { value: "Needs cleanup", detail: "Liquidity positions can block a clean exit.", tone: "fail" };
  }
  if (label === "Allowances") {
    if (!row || row.status === "skipped" || row.status === "unknown") {
      return {
        value: "Manual review",
        detail: "Spender configuration was not fully available, so approvals need a manual look.",
        tone: "unknown",
      };
    }
    return row.status === "pass"
      ? { value: "Clear", detail: "No active token approvals were returned by the scan.", tone: "pass" }
      : { value: "Needs review", detail: "Active approvals may still let external spenders move assets.", tone: "fail" };
  }
  if (label === "Extra signers / shared control") {
    return row?.status === "pass"
      ? { value: "Single control", detail: "No additional signers were detected.", tone: "pass" }
      : { value: "Shared control", detail: "This account may use shared control or multisig-style approvals.", tone: "fail" };
  }
  if (label === "Thresholds / approval rules") {
    return row?.status === "pass"
      ? { value: "Default", detail: "Approval rules are at the expected defaults.", tone: "pass" }
      : { value: "Review rules", detail: "Custom approval rules should be checked before cleanup or close.", tone: "fail" };
  }
  if (label === "Manual protocol review") {
    return row?.status === "pass"
      ? { value: "None", detail: "No extra protocol review was returned by the latest scan.", tone: "pass" }
      : { value: "Review", detail: "Protocol details should be expanded before you close this account.", tone: "unknown" };
  }
  if (label === "Destination") {
    return {
      value: "Not set",
      detail: "Choose and verify a destination before triggering the final close flow.",
      tone: "unknown",
    };
  }
  if (label === "Close readiness") {
    return health.canDemolish
      ? { value: "Ready", detail: "No required blockers remain, though manual review is still recommended.", tone: "pass" }
      : { value: "Blocked", detail: "Open cleanup items still need attention before close.", tone: "fail" };
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
  if (row.id === "native_merge_payout") return { label: "Review close flow", onClick: opts.onCloseStep };
  if (row.id === "classic_min_reserve") return { label: "Set destination", onClick: opts.onCloseStep };
  if (row.id === "defi_positions") return { label: "Review manually" };
  if (row.id === "soroban_allowances") {
    if (row.status === "skipped" || row.status === "unknown") return { label: "Review approvals" };
    return opts.walletConnected ? { label: "Revoke allowance" } : { label: "Connect Wallet", onClick: opts.onConnectWallet };
  }
  const blockerActions: Partial<Record<string, { code: BlockerCode; label: string }>> = {
    classic_open_offers: { code: "OPEN_OFFERS", label: "Cancel open offers" },
    classic_claimable_balances: { code: "CLAIMABLE_BALANCES_PENDING", label: "Claim balance" },
    classic_sponsorship: { code: "SPONSORING_OTHER_ACCOUNTS", label: "Resolve sponsorship" },
    classic_data_entries: { code: "DATA_ENTRIES", label: "Remove data entries" },
    classic_extra_signers: { code: "MULTISIG_OR_EXTRA_SIGNERS", label: "Review signers" },
    classic_thresholds: { code: "NON_DEFAULT_THRESHOLDS", label: "Review approval rules" },
    classic_amm_lp_shares: { code: "OPEN_LIQUIDITY_POOL", label: "Close position" },
  };
  if (row.id === "classic_trustlines") {
    return opts.walletConnected ? { label: "Open trustline planner" } : { label: "Connect Wallet", onClick: opts.onConnectWallet };
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
  trustlinePanel,
  embedded = false,
}: {
  health: HealthReport;
  checklist: HealthChecklistItem[];
  walletConnected: boolean;
  walletBusy: boolean;
  onConnectWallet: () => void;
  onCloseStep: () => void;
  onResolveClassicBlocker: (code: BlockerCode) => void;
  trustlinePanel?: ReactNode;
  embedded?: boolean;
}) {
  const byId = new Map(checklist.map((row) => [row.id, row]));
  const groups = [
    {
      id: "unlock-value",
      title: "Unlock value",
      description: "Reserve release, claimable balances, and token-line cleanup live here.",
      rows: [
        ["Estimated reserve release", byId.get("classic_trustlines")],
        ["Claimable balances", byId.get("classic_claimable_balances")],
        ["Token-line cleanup opportunities", byId.get("classic_trustlines")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      id: "remove-blockers",
      title: "Remove blockers",
      description: "Fix the account state that most often prevents cleanup or close.",
      rows: [
        ["Trustlines", byId.get("classic_trustlines")],
        ["Sponsorships", byId.get("classic_sponsorship")],
        ["Open activity", byId.get("classic_open_offers") ?? byId.get("classic_amm_lp_shares")],
        ["LP positions", byId.get("classic_amm_lp_shares")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      id: "review-permissions",
      title: "Review permissions",
      description: "Check approvals, control rules, and shared access before write actions.",
      rows: [
        ["Allowances", byId.get("soroban_allowances")],
        ["Extra signers / shared control", byId.get("classic_extra_signers")],
        ["Thresholds / approval rules", byId.get("classic_thresholds")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      id: "close-safely",
      title: "Close safely",
      description: "Confirm destination, manual review, and final readiness before the irreversible step.",
      rows: [
        ["Destination", undefined],
        ["Manual protocol review", byId.get("defi_positions")],
        ["Close readiness", byId.get("classic_min_reserve")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
  ];
  const protocols = health.openPositions?.defiProtocols ?? [];

  return (
    <section className={embedded ? "snapshotDetails" : "reportSurface"}>
      <div className="sectionHeaderRow sectionHeaderRow--compact">
        <div>
          <h2 className="cardTitle">Actionable report</h2>
          <p className="hint">Each section keeps the default view short and moves technical detail behind expanders.</p>
        </div>
      </div>

      <div className="stateDetailGrid">
        {groups.map((group) => (
          <details key={group.title} className={`stateDetailGroup stateDetailGroup--${group.id}`}>
            <summary className="stateDetailGroupSummary">
              <div className="stateDetailGroupHeading">
                <h3>{group.title}</h3>
                <p>{group.description}</p>
              </div>
              <span className="stateDetailGroupMeta">
                <span>
                  {group.rows.length} item{group.rows.length === 1 ? "" : "s"}
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
                    : label === "Estimated reserve release"
                      ? walletConnected
                        ? { label: "Open trustline planner", onClick: onCloseStep }
                        : { label: "Connect Wallet", onClick: onConnectWallet }
                      : label === "Close readiness"
                        ? walletConnected
                          ? { label: "Open close flow", onClick: onCloseStep }
                          : { label: "Connect Wallet", onClick: onConnectWallet }
                        : label === "Token-line cleanup opportunities"
                          ? { label: "Open trustline planner", onClick: onCloseStep }
                          : rowActionFor(row, {
                            walletConnected,
                            walletBusy,
                            onConnectWallet,
                            onCloseStep,
                            onResolveClassicBlocker,
                          });
                return (
                  <details key={label} className={`scanReportRow scanReportRow--${group.id}`}>
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
                            <dt>State</dt>
                            <dd>{outcomeLabel(row)}</dd>
                          </div>
                          <div>
                            <dt>Risk</dt>
                            <dd>{row.blocksDemolish ? "Blocks cleanup" : "Review only"}</dd>
                          </div>
                          <div>
                            <dt>Check ID</dt>
                            <dd>{row.id}</dd>
                          </div>
                        </dl>
                      ) : null}
                    </div>
                  </details>
                );
              })}
              {group.id === "unlock-value" && trustlinePanel ? <div className="scanReportEmbeddedPanel">{trustlinePanel}</div> : null}
            </div>
          </details>
        ))}
      </div>

      {protocols.length > 0 ? (
        <div className="protocolList">
          <h3>Manual protocol review</h3>
          {protocols.map((protocol) => (
            <article key={protocol.id} className="protocolRow">
              <div>
                <strong>{protocol.label}</strong>
                <p>{protocol.detail}</p>
              </div>
              <span className={`stateValue stateValue--${protocol.status}`}>
                {protocol.status === "pass" ? "Clear" : protocol.status === "fail" ? "Review" : "Manual"}
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
  const [closeConfirm, setCloseConfirm] = useState("");
  const [didAutoloadQueryAccount, setDidAutoloadQueryAccount] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [trustlineSummary, setTrustlineSummary] = useState<TrustlineCleanupSummary | null>(null);

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
      await openWalletProfileWithKit(network);
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  }, [network]);

  useEffect(() => {
    document.title = "Orbitway | App";
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
    setTrustlineSummary(null);
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
    setTrustlineSummary(null);
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
  const trustlineReserveXlm =
    trustlineSummary
      ? trustlineSummary.total * BASE_RESERVE_XLM
      : checklistById.get("classic_trustlines")?.status === "pass"
        ? 0
        : undefined;
  const protocolReviewCount =
    health?.openPositions?.defiProtocols.filter((protocol) => protocol.status === "unknown" || protocol.status === "fail").length ?? 0;
  const openPositionCount =
    (health?.openPositions?.liquidityPoolShares.length ?? 0) + (health?.openPositions?.sdexOffers.length ?? 0);
  const claimableBalanceRow = checklistById.get("classic_claimable_balances");
  const claimableBalanceLabel = !claimableBalanceRow
    ? "Unable to verify"
    : claimableBalanceRow.status === "pass"
      ? "None found"
      : "Available";
  const permissionReviewCount = [
    checklistById.get("classic_extra_signers"),
    checklistById.get("classic_thresholds"),
    checklistById.get("soroban_allowances"),
  ].filter((row) => row && row.status !== "pass").length;
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

  const scanStatus = health ? "Latest scan" : "Ready to scan";
  const healthStatus = sourceTrim ? (isSaved ? "Saved" : "Not saved") : "Saved accounts";
  const closeStatus = !sourceTrim || !health ? "Locked" : readyByHealth ? "Ready to close" : "Needs cleanup";
  const accountStateLabel = !health ? "Awaiting scan" : health.canDemolish ? "Ready" : blocking.length > 0 ? "Needs cleanup" : "Needs review";
  const reserveReleaseLabel =
    typeof trustlineReserveXlm === "number" ? formatXlmCompact(trustlineReserveXlm) : "Not estimated yet";
  const trustlineStateLabel =
    trustlineSummary
      ? `${trustlineSummary.total} token line${trustlineSummary.total === 1 ? "" : "s"}`
      : checklistById.get("classic_trustlines")?.status === "pass"
        ? "None detected"
        : "Needs cleanup";
  const manualReviewStateLabel =
    protocolReviewCount === 0
      ? "No manual review flags"
      : `${protocolReviewCount} item${protocolReviewCount === 1 ? "" : "s"} to review`;
  const permissionStateLabel = permissionReviewCount === 0 ? "Clear" : `${permissionReviewCount} review${permissionReviewCount === 1 ? "" : "s"}`;
  const destinationStateLabel = destOk ? "Set" : "Missing";

  return (
    <div className="page page--app">
      <main className="workspace workspace--shell">
        <aside className="consoleSidebar">
          <div className="consoleSidebarTop">
            <div className="brand">
              <img className="brandMark" src="/orbitway-logo.png" alt="" />
              <div>
                <div className="brandName">Orbitway</div>
                <div className="brandTag">Account health and cleanup</div>
              </div>
            </div>
            <p className="sidebarIntro">Account health, cleanup, and safe exit for Stellar.</p>
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
                  className={`sidebarNavButton sidebarNavButton--${id}${activeSection === id ? " sidebarNavButton--active" : ""}`}
                  onClick={() => setActiveSection(id as AppSection)}
                >
                <span className="sidebarNavLabel">{label}</span>
                <span className="sidebarNavMeta">{detail}</span>
              </button>
            ))}
          </nav>

          <div className="sidebarBottom">
            <div className="sidebarWalletCard">
              <strong>{walletAddress ? formatAccount(walletAddress) : "Wallet not connected"}</strong>
              <span>{walletAddress ? "Connected for write actions" : "Connect only when you need to sign"}</span>
            </div>
          </div>
        </aside>

        <section className="consoleContent">
          <header className="consoleTopbar">
            <div className="topbarNetworkControl">
              <span>Network</span>
              <label className="networkSelectWrap" aria-label="Stellar network">
                <select
                  className="networkSelect"
                  value={network}
                  onChange={(event) => {
                    setNetwork(event.target.value as UiNetwork);
                    setHealth(null);
                  }}
                >
                  <option value="testnet">Testnet</option>
                  <option value="mainnet">Mainnet</option>
                </select>
              </label>
            </div>
            <div className="consoleTopbarActions">
              {walletAddress ? (
                <>
                  <button type="button" className="btn secondary" disabled={walletBusy} onClick={openWalletProfile}>
                    Switch Wallet
                  </button>
                  <button type="button" className="btn ghost" disabled={walletBusy} onClick={disconnectWallet}>
                    Disconnect
                  </button>
                </>
              ) : (
                <button type="button" className="btn secondary" disabled={walletBusy} onClick={connectWallet}>
                  {walletBusy ? "Opening…" : "Connect Wallet"}
                </button>
              )}
            </div>
          </header>

          {activeSection === "scan" ? (
            <section className="appSection appSection--scan">
              <div className="scanHero">
                <SectionKicker>Quiet Orbital Utility</SectionKicker>
                <h1>Check account health.</h1>
                <p>Scan a Stellar address to see what needs attention before you clean up or close the account.</p>
              </div>

              <section className="scanWorkspace">
                <div className="card consolePrimaryCard scanFormCard scanFormCard--hero">
                  <h2 className="cardTitle">Scan a Stellar address</h2>
                  <div className="scanInputRow">
                    <div className="overviewControlBlock scanInputControl">
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
                    <button type="button" className="btn primary scanSubmit" disabled={loading} onClick={runHealthCheck}>
                      {loading ? "Scanning…" : "Scan"}
                    </button>
                  </div>
                  <p className="hint scanHelper">No signing is required to scan. Use your wallet only when you approve a cleanup or close action.</p>
                  {walletError ? <p className="error">{walletError}</p> : null}
                  {error ? <p className="error">{error}</p> : null}
                  {walletMismatch ? (
                    <p className="error">
                      Connected wallet <code className="inlineCode">{walletAddress?.slice(0, 8)}…</code> does not match the
                      selected account.
                    </p>
                  ) : null}
                </div>
              </section>

              {!health ? (
                <section className="supportBand">
                  <article className="card consolePrimaryCard scanInfoCard">
                    <h2 className="cardTitle">What the scan checks</h2>
                    <ul className="scanCheckList">
                      {scanChecklistLabels.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </article>
                  <article className="card consolePrimaryCard scanInfoCard">
                    <h2 className="cardTitle">Non-custodial by design</h2>
                    <p className="hint">
                      Orbitway never needs your private key to scan. Actions are reviewed separately and signed through
                      your wallet.
                    </p>
                  </article>
                  <article className="card consolePrimaryCard scanInfoCard scanEmptyState">
                    <h2 className="cardTitle">Ready when you are</h2>
                    <p className="hint">Run a read-only scan to see account state, cleanup blockers, and releaseable reserve.</p>
                  </article>
                </section>
              ) : null}

              {health ? (
                <>
                  <section className="snapshotSurface">
                    <div className="sectionHeaderRow sectionHeaderRow--compact">
                      <div>
                        <h2 className="cardTitle">Account health snapshot</h2>
                        <p className={`summary ${health.canDemolish ? "ok" : "warn"}`}>{health.summary}</p>
                      </div>
                    </div>

                    <div className="snapshotBandGrid">
                      <article className="snapshotBand snapshotBand--state">
                        <span className="snapshotEyebrow">Account state</span>
                        <strong className="snapshotValue">{accountStateLabel}</strong>
                        <p className="snapshotSentence">{health.summary}</p>
                        <div className="snapshotList">
                          <div>
                            <span>Why it matters</span>
                            <strong>{blocking.length > 0 ? `${blocking.length} blocker${blocking.length === 1 ? "" : "s"}` : "No required blockers"}</strong>
                          </div>
                          <div>
                            <span>Open activity</span>
                            <strong>{openPositionCount > 0 ? `${openPositionCount} item${openPositionCount === 1 ? "" : "s"}` : "None detected"}</strong>
                          </div>
                        </div>
                      </article>
                      <article className="snapshotBand snapshotBand--value">
                        <span className="snapshotEyebrow">Locked value</span>
                        <strong className="snapshotValue">{reserveReleaseLabel}</strong>
                        <p className="snapshotSentence">
                          {typeof trustlineReserveXlm === "number"
                            ? "Estimated reserve release tied to trustline cleanup."
                            : "The reserve estimate becomes clearer after token-line cleanup is loaded."}
                        </p>
                        <div className="snapshotList">
                          <div>
                            <span>Trustline cleanup</span>
                            <strong>{trustlineStateLabel}</strong>
                          </div>
                          <div>
                            <span>Claimable balances</span>
                            <strong>{claimableBalanceLabel}</strong>
                          </div>
                        </div>
                      </article>
                      <article className="snapshotBand snapshotBand--review">
                        <span className="snapshotEyebrow">Manual review</span>
                        <strong className="snapshotValue">{manualReviewStateLabel}</strong>
                        <p className="snapshotSentence">Review permissions, shared control, and destination details before final close.</p>
                        <div className="snapshotList">
                          <div>
                            <span>Permissions review</span>
                            <strong>{permissionStateLabel}</strong>
                          </div>
                          <div>
                            <span>Destination status</span>
                            <strong>{destinationStateLabel}</strong>
                          </div>
                        </div>
                      </article>
                    </div>
                  </section>

                  <AccountStateDetails
                    embedded
                    health={health}
                    checklist={checklist}
                    walletConnected={Boolean(walletAddress)}
                    walletBusy={walletBusy}
                    onConnectWallet={connectWallet}
                    onCloseStep={() => setActiveSection("close")}
                    onResolveClassicBlocker={(code) => {
                      void resolveClassicBlocker(code);
                    }}
                    trustlinePanel={
                      showTrustlineTeardown && health.horizonUrl ? (
                        <TrustlineTeardownCard
                          embedded
                          accountId={sourceTrim}
                          network={network}
                          horizonUrl={health.horizonUrl}
                          walletAddress={walletAddress}
                          walletMismatch={Boolean(walletMismatch)}
                          walletBusy={walletBusy}
                          setWalletBusy={setWalletBusy}
                          setWalletError={setWalletError}
                          setActionSuccess={setActionSuccess}
                          offersBlocked={checklistById.get("classic_open_offers")?.status === "fail"}
                          onSummaryChange={setTrustlineSummary}
                          onSubmitted={refreshHealth}
                        />
                      ) : undefined
                    }
                  />

                  <div className="sectionActions sectionActions--scanFooter">
                    <button type="button" className="btn primary" onClick={() => setActiveSection("close")}>
                      Open close flow
                    </button>
                    <button type="button" className="btn secondary" onClick={() => saveAccountToWatchlist(sourceTrim, network, health)}>
                      {isSaved ? "Saved in Health" : "Save to Health"}
                    </button>
                    <button type="button" className="btn secondary" onClick={resetOverview}>
                      Scan another account
                    </button>
                  </div>

                  <section className="supportBand supportBand--lower">
                    <article className="card consolePrimaryCard scanInfoCard">
                      <h2 className="cardTitle">What the scan checks</h2>
                      <ul className="scanCheckList">
                        {scanChecklistLabels.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </article>
                    <article className="card consolePrimaryCard scanInfoCard">
                      <h2 className="cardTitle">Snapshot focus</h2>
                      <p className="hint">
                        Trustlines, sponsorships, allowances, and close blockers map directly into the report below.
                      </p>
                    </article>
                    <article className="card consolePrimaryCard scanInfoCard">
                      <h2 className="cardTitle">Non-custodial by design</h2>
                      <p className="hint">Scanning stays read-only. Signing only happens when you choose a write action.</p>
                    </article>
                  </section>

                  {health ? (
                    <details className="technicalDetails technicalDetails--quiet">
                      <summary>
                        <span>Technical details</span>
                        <strong>{checklist.length} checks</strong>
                      </summary>
                      <ul className="checklistList">
                        {checklist.map((row) => (
                          <li key={row.id} className={`checklistRow status-${row.status}`} aria-label={`${row.label}: ${outcomeLabel(row)}`}>
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
            </section>
          ) : null}

          {activeSection === "health" ? (
            <section className="appSection appSection--health">
              <div className="pageIntro pageHeader pageHeader--compact">
                <div className="pageHeaderCopy">
                  <SectionKicker>Health</SectionKicker>
                  <h1>Saved accounts</h1>
                  <p>Keep a clean list of accounts you want to revisit for health, cleanup, and final close.</p>
                </div>
                <div className="pageHeaderStatus">
                  <span>Saved accounts</span>
                  <strong>{watchlist.length}</strong>
                  <small>{sourceTrim ? `Current: ${formatAccount(sourceTrim)}` : "Scan first, save later"}</small>
                </div>
              </div>

              <section className="card consolePrimaryCard watchlistComposer">
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
                </div>
                <div className="sectionActions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => saveAccountToWatchlist(watchlistDraft, network)}
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
                  <h2 className="cardTitle">No saved accounts yet</h2>
                  <p className="hint">Scan an address and save it to track account health over time.</p>
                  <div className="sectionActions">
                    <button type="button" className="btn primary" onClick={() => setActiveSection("scan")}>
                      Go to Scan
                    </button>
                  </div>
                </section>
              ) : (
                <section className="healthTable" aria-label="Saved accounts">
                  <div className="healthTableHeader">
                    <span>Account</span>
                    <span>Blockers</span>
                    <span>Health state</span>
                    <span>Reserve release</span>
                    <span>Trustline cleanup</span>
                    <span>Manual review</span>
                    <span className="healthTableHeaderAction">Action</span>
                  </div>
                  {watchlist.map((entry) => (
                    <article
                      key={`${entry.network}:${entry.accountId}`}
                      className={`healthRowCard${entry.readyToClose ? " healthRowCard--ready" : entry.blockersCount ? " healthRowCard--cleanup" : " healthRowCard--review"}`}
                    >
                      <div className="healthRowCell healthRowCell--account" data-label="Account">
                        <strong>{formatAccount(entry.accountId)}</strong>
                        <span>{entry.readyToClose ? "Ready for final review" : entry.blockersCount ? "Cleanup needed before close" : "Rescan to refresh status"}</span>
                      </div>
                      <div className="healthRowCell" data-label="Blockers">
                        <strong>{entry.blockersCount ? `${entry.blockersCount} blocker${entry.blockersCount === 1 ? "" : "s"}` : "None"}</strong>
                      </div>
                      <div className="healthRowCell" data-label="Health state">
                        <strong>{entry.readyToClose ? "Ready" : entry.blockersCount ? "Needs cleanup" : "Needs review"}</strong>
                      </div>
                      <div className="healthRowCell" data-label="Reserve release">
                        <strong>
                          {typeof entry.nativeBalanceXlm === "number" ? formatXlmCompact(entry.nativeBalanceXlm) : "Scan again"}
                        </strong>
                      </div>
                      <div className="healthRowCell" data-label="Trustline cleanup">
                        <strong>{entry.readyToClose ? "Clear" : "Check cleanup"}</strong>
                      </div>
                      <div className="healthRowCell" data-label="Manual review">
                        <strong>{entry.readyToClose ? "Low" : "Review"}</strong>
                      </div>
                      <div className="healthRowCell healthRowCell--action" data-label="Action">
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
                        <button type="button" className="btn secondary" onClick={() => removeFromWatchlist(entry.accountId, entry.network)}>
                          Remove
                        </button>
                      </div>
                    </article>
                  ))}
                </section>
              )}
            </section>
          ) : null}

          {activeSection === "close" ? (
            <section className="appSection appSection--close">
              <div className="pageIntro pageHeader pageHeader--compact">
                <div className="pageHeaderCopy">
                  <SectionKicker>Close Account</SectionKicker>
                  <h1>{sourceTrim ? "Close account" : "Select an account to close."}</h1>
                  <p>
                    {sourceTrim
                      ? "Keep the final close flow distinct, serious, and irreversible."
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
                  <h2 className="cardTitle">Pick an account first</h2>
                  <p className="hint">Scan an account or open one from Health before you begin the close flow.</p>
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
                      <h2 className="cardTitle">This account still has blockers.</h2>
                      <p className="hint">Route back to Scan and clear the relevant cleanup rows before closing.</p>
                    </div>
                    <span className="statusBadge statusBadge--warn">Blocked</span>
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
                    <p className="meta">Unable to verify close readiness. Scan again to refresh the state.</p>
                  )}
                  <div className="sectionActions">
                    <button type="button" className="btn primary" onClick={() => setActiveSection("scan")}>
                      Review cleanup
                    </button>
                  </div>
                </section>
              ) : (
                <>
                  {!walletAddress ? (
                    <section className="card consolePrimaryCard">
                      <h2 className="cardTitle">Connect wallet to continue</h2>
                      <p className="hint">Close execution requires wallet approval from the selected account owner.</p>
                      <div className="sectionActions">
                        <button type="button" className="btn primary" disabled={walletBusy} onClick={connectWallet}>
                          {walletBusy ? "Opening…" : "Connect Wallet"}
                        </button>
                      </div>
                    </section>
                  ) : null}

                  <section className="card consolePrimaryCard closeReviewSurface">
                    <div className="sectionHeaderRow">
                      <div>
                        <h2 className="cardTitle">Close readiness</h2>
                        <p className="summary ok">The account can be closed once you confirm the destination and final warning.</p>
                      </div>
                      <span className="statusBadge statusBadge--ok">Ready</span>
                    </div>

                    <div className="closeReviewGrid">
                      <div className="closeReviewCard">
                        <span>Final payout / reserve release</span>
                        <strong>{reserveReleaseLabel}</strong>
                        <small>Final payout adjusts for fees and destination confirmation.</small>
                      </div>
                      <div className="closeReviewCard">
                        <span>Manual review reminders</span>
                        <strong>{manualReviewStateLabel}</strong>
                        <small>Review protocol details before you sign the last transaction.</small>
                      </div>
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

                    <div className="closeWarning">
                      <strong>Closing an account is irreversible.</strong>
                      <p>
                        Native XLM moves to the destination address. Non-native assets and blockers must be cleared
                        first.
                      </p>
                    </div>

                    <div className="closeReviewGrid">
                      <div className="closeReviewCard">
                        <span>Destination</span>
                        <strong>{destination.trim() ? formatAccount(destination.trim()) : "Not provided"}</strong>
                        <small>Keep this close to the warning so the final step stays obvious.</small>
                      </div>
                      <div className="closeReviewCard">
                        <span>Account state</span>
                        <strong>{accountStateLabel}</strong>
                        <small>{health.summary}</small>
                      </div>
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

                    {walletError ? <p className="error">{walletError}</p> : null}

                    <div className="closeActionTray">
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() => setActiveSection("scan")}
                      >
                        Review cleanup
                      </button>
                      <button
                        type="button"
                        className="btn danger"
                        disabled={
                          !destOk ||
                          closeConfirm !== "CLOSE" ||
                          !walletAddress ||
                          walletBusy ||
                          mergeBusy ||
                          Boolean(walletMismatch) ||
                          !health.horizonUrl
                        }
                        title="Sign final close in your wallet. This action is irreversible once confirmed on-chain."
                        onClick={() => void runAccountMerge()}
                      >
                        {mergeBusy ? "Closing account…" : "Close Account"}
                      </button>
                    </div>
                  </section>
                </>
              )}
            </section>
          ) : null}
        </section>
      </main>
    </div>
  );
}

export function App() {
  const route = useRouteMode();
  return route === "app" ? <AppShell /> : <LandingPage />;
}
