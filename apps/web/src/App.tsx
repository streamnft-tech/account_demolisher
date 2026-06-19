import { Component, useCallback, useEffect, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import type { Blocker, BlockerCode, HealthChecklistItem, HealthReport } from "@stellar/core";
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
type AppSection = "scan" | "review" | "clean" | "merge";
type ReviewTab = "recoverable" | "blockers" | "control" | "defi";
type CleanupStepId =
  | "cancel-open-offers"
  | "route-asset-balances"
  | "revoke-sponsorships"
  | "remove-trustlines"
  | "clear-data-entries"
  | "set-account-control"
  | "review-soroban-state";
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
    title: "Locked reserves",
    body: "Trustlines, offers, data entries, signers, sponsorships, liquidity positions, allowances, and Soroban / DeFi activity can keep XLM reserved long after an account stops being used.",
  },
  {
    title: "Hidden blockers",
    body: "Any unresolved item can block cleanup, make ACCOUNT_MERGE fail, or leave recoverable XLM behind.",
  },
  {
    title: "Irreversible close",
    body: "Final account merge is irreversible. Orbitway keeps cleanup and closure separate so users can review every step before signing.",
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
    title: "No signing required to scan",
    body: "Run a read-only account scan first. Wallet approval starts only when you choose a cleanup action.",
    featured: true,
  },
  {
    title: "Cleanup actions are wallet-approved",
    body: "Every write action stays separate and is approved through the connected wallet.",
  },
  {
    title: "Private keys stay private",
    body: "Secret keys and signing authority stay in the user’s wallet and never move to Orbitway servers.",
  },
  {
    title: "Final close remains separate",
    body: "Account closure stays distinct from cleanup and is treated as the irreversible final step.",
  },
];

const coverageGroups = [
  {
    title: "Unlock value",
    body: "Show balances and reserves users may be able to recover or route before close.",
    items: [
      "Native XLM balance",
      "Estimated reserve release",
      "Trustline reserves",
      "Claimable balances",
      "Routeable asset balances",
    ],
  },
  {
    title: "Remove blockers",
    body: "Group account state that must be resolved before cleanup or final merge can complete safely.",
    items: [
      "Sponsorships",
      "Open offers",
      "Data entries",
      "Liquidity positions",
      "Signer / threshold issues",
      "Unsupported Soroban / DeFi state",
    ],
  },
  {
    title: "Close safely",
    body: "Keep the irreversible step visible, deliberate, and separate from earlier cleanup work.",
    items: [
      "Destination status",
      "Wallet payout",
      "Exchange memo / tag warnings",
      "ACCOUNT_MERGE compatibility",
      "Final close readiness",
    ],
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

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error("[orbitway] app render error", error, info);
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page page--app appErrorShell">
          <main className="appErrorCard" role="alert" aria-live="assertive">
            <SectionKicker>Render error</SectionKicker>
            <h1>Orbitway could not render this page.</h1>
            <p>
              A runtime error is still blocking the app shell. Open the console for the exact stack trace, then we can fix
              the broken render path.
            </p>
            <pre>{this.state.error.message}</pre>
          </main>
        </div>
      );
    }

    return this.props.children;
  }
}

// Legacy hero result preview kept for quick comparison/revert while the orbital preview is evaluated.
function AccountHealthResultLegacy() {
  const cleanupRows = [
    { step: "1", label: "Clear data entries", detail: "Remove stale account data", value: "+0.50 XLM" },
    { step: "2", label: "Normalize signers", detail: "remove extra signer", value: "+1.00 XLM" },
    { step: "3", label: "Cancel sponsorships", detail: "Revoke reserves paid for other entries", value: "+0.50 XLM" },
    { step: "4", label: "Close DeFi offers", detail: "4 open offers", value: "+3.80 XLM" },
    { step: "5", label: "Convert assets to XLM", detail: "5 tokens routed", value: "+2.30 XLM" },
    { step: "6", label: "Remove trustlines", detail: "3 trustlines found", value: "+1.50 XLM" },
    { step: "7", label: "Prepare account merge", detail: "Set destination before final close", value: "+1.00 XLM" },
  ];

  return (
    <aside className="cleanupPreview accountHealthPreview" aria-label="Example account health result preview">
      <div className="cleanupPreviewTop">
        <div>
          <span>Account health result</span>
          <strong>GABCD…WXYZ</strong>
        </div>
        <em className="healthStatusChip">
          <span>Scanning</span>
          <span>Not ready to close</span>
          <span>7 blockers found</span>
          <span>Ready to close</span>
        </em>
      </div>
      <ol className="cleanupPlanList">
        {cleanupRows.map((item) => (
          <li key={item.label} className="cleanupPlanStep accountHealthStep">
            <span>{item.step}</span>
            <div>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </div>
            <em>{item.value}</em>
          </li>
      ))}
      </ol>
      <div className="healthProgress">
        <span aria-label="Animated blockers cleared progress">
          <b>1 / 7 blockers cleared</b>
          <b>2 / 7 blockers cleared</b>
          <b>3 / 7 blockers cleared</b>
          <b>4 / 7 blockers cleared</b>
          <b>5 / 7 blockers cleared</b>
          <b>6 / 7 blockers cleared</b>
          <b>7 / 7 blockers cleared</b>
        </span>
        <div aria-hidden="true">
          <i />
        </div>
      </div>
      <div className="cleanupPreviewValue">
        <span>Estimated unlockable reserve</span>
        <strong>10.60 XLM</strong>
        <small>Before wallet approval</small>
      </div>
    </aside>
  );
}

function AccountHealthPreview({ liveStats }: { liveStats: LiveStatsState }) {
  const orbitCards = [
    { label: "Trustlines", detail: "3 trustlines", value: "+1.50 XLM" },
    { label: "Open offers", detail: "4 open offers", value: "+2.00 XLM" },
    { label: "Data entries", detail: "1 data entry", value: "+0.50 XLM" },
    { label: "Signer settings", detail: "1 extra signer", value: "+0.50 XLM" },
    { label: "Sponsorships", detail: "Review needed", value: "+0.50 XLM" },
    { label: "Routeable assets", detail: "5 tokens routed", value: "+2.30 XLM" },
    { label: "Base reserve", detail: "Final merge", value: "+1.00 XLM" },
  ];

  return (
    <aside
      className="accountHealthPreview"
      aria-label="Example orbital account health result preview"
      data-legacy-preview={AccountHealthResultLegacy.name}
    >
      <div className="orbitalPreview orbitalPreview--desktop" aria-hidden="true">
        <div className="orbitalRings" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="orbitalStatusPill" aria-hidden="true">
          <span className="orbitalStatusDot" />
          <strong className="orbitalStatusText">
            <span>Scan complete · blockers found</span>
            <span>Blockers Resolved. Ready for merge.</span>
          </strong>
        </div>
        <div className="orbitalCenter">
          <strong>GABCD...WXYZ</strong>
        </div>
        <div className="orbitalCards">
          {orbitCards.map((item, index) => (
            <div
              key={item.label}
              className="orbitalCard"
              style={{ "--orbit-index": index } as CSSProperties}
            >
              <span>{item.label}</span>
              <strong>
                <b>{item.detail}</b>
                <b>{item.value}</b>
              </strong>
            </div>
          ))}
        </div>
        <div className="orbitalReserveTrail" aria-hidden="true">
          <i />
        </div>
        <div className="orbitalBottom">
          <div className="orbitalReserve">
            <span>Recovered reserve</span>
            <strong>8.30 XLM</strong>
          </div>
        </div>
      </div>

      <div className="mobileHealthPreview">
        <div className="mobileHealthPreviewTop">
          <span className="mobileHealthStatusDot" />
          <strong>Scan complete · blockers found</strong>
        </div>
        <div className="mobileHealthAccount">GABCD...WXYZ</div>
        <div className="mobileHealthRows">
          {orbitCards.map((item) => (
            <div key={item.label} className="mobileHealthRow">
              <div className="mobileHealthRowCopy">
                <span>{item.label}</span>
                <strong>{item.detail}</strong>
              </div>
              <em>{item.value}</em>
            </div>
          ))}
        </div>
        <div className="mobileHealthReserve">
          <span>Recovered reserve</span>
          <strong>8.30 XLM</strong>
        </div>
      </div>

      <LiveStatsPanel stats={liveStats} compact />
    </aside>
  );
}

function LandingPage({ liveStats }: { liveStats: LiveStatsState }) {
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
            <div className="brandName">Orbit<span className="brandNameAccent">way</span></div>
            <div className="brandTag">Account health and cleanup</div>
          </div>
        </div>
        <div className="nav nav--desktop nav--actions">
          <NavLink href="#how-it-works" muted>
            How it works
          </NavLink>
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
              <NavLink href="#how-it-works" muted>
                How it works
              </NavLink>
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
            <SectionKicker>Non-custodial Stellar account cleanup</SectionKicker>
            <h1>
              Recover <span className="heroAccentWord heroAccentWord--locked">locked</span> XLM by clearing Stellar
              account <span className="heroAccentWord heroAccentWord--blockers">blockers</span>.
            </h1>
            <p className="heroText">
              Orbitway scans your account, finds what is keeping reserves locked, and turns trustlines, offers,
              signers, sponsorships, data entries, liquidity positions, and Soroban / DeFi activity into a
              step-by-step cleanup path.
            </p>
            <div className="safetyMeta" aria-label="Orbitway safety promises">
              <span>Read-only scan</span>
              <span>Wallet approval only for cleanup</span>
              <span>Private keys stay in your wallet</span>
            </div>
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
                placeholder="Paste Stellar address"
                value={heroAddress}
                onChange={(event) => setHeroAddress(event.target.value)}
                spellCheck={false}
                autoCapitalize="none"
              />
              <div className="heroSearchActions">
                <button type="submit" className="btn primary heroSubmit">
                  Scan account
                </button>
              </div>
            </form>
            <div className="heroActions">
              <NavLink href="#how-it-works" muted>
                See how it works
              </NavLink>
            </div>
          </div>
          <AccountHealthPreview liveStats={liveStats} />
        </section>

        <section className="infoGrid infoGrid--landing" id="problem">
          <article className="contentCard problemCopy">
            <SectionKicker>Problem</SectionKicker>
            <h2>Your XLM can stay locked behind account state you no longer use.</h2>
            <p>
              A Stellar account can keep reserves locked through trustlines, offers, data entries, signers,
              sponsorships, liquidity positions, allowances, and Soroban / DeFi activity long after the account stops
              being used.
            </p>
            <p>
              Any unresolved item can block cleanup, make <code>ACCOUNT_MERGE</code> fail, or leave recoverable XLM
              behind.
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
            <h2>Scan first. Clean in order. Close only when ready.</h2>
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
                "See reserves, trustlines, sponsorships, permissions, and blockers before approving any transaction.",
              ],
              [
                "2",
                "Understand",
                "Separate unlockable value from account-state blockers and manual review items.",
              ],
              [
                "3",
                "Clean",
                "Resolve account state through wallet-signed transactions, one reviewed action at a time.",
              ],
              [
                "4",
                "Close safely",
                "Close the account only after blockers are cleared, then route remaining funds to your chosen wallet or exchange destination.",
              ],
            ].map(([num, title, body]) => (
              <article key={title} className="stepCard">
                <div className="stepHeader">
                  <div className="stepNumber">{num}</div>
                  <h3>{title}</h3>
                </div>
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
            <h2>Everything that can block cleanup, grouped by the action it affects.</h2>
            <p>
              Orbitway translates protocol-level account state into simple decisions: what can be recovered, what must
              be cleared, and when the account is ready to merge or payout.
            </p>
          </div>
          <div className="coverageGrid">
            {coverageGroups.map((group) => (
              <article key={group.title} className="coverageGroup">
                <h3>{group.title}</h3>
                <p>{group.body}</p>
                <ul>
                  {group.items.map((item) => (
                    <li key={item}>
                      {item === "ACCOUNT_MERGE compatibility" ? (
                        <>
                          <code>ACCOUNT_MERGE</code> compatibility
                        </>
                      ) : (
                        item
                      )}
                    </li>
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
              visibility and cleanup guidance after the consumer scan workflow is clear.
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
          <h2>Start with a scan. See what&apos;s keeping XLM locked.</h2>
          <p>Inspect any Stellar account before signing, cleaning, or closing anything.</p>
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
              placeholder="Paste Stellar address"
              value={heroAddress}
              onChange={(event) => setHeroAddress(event.target.value)}
              spellCheck={false}
              autoCapitalize="none"
            />
            <div className="heroSearchActions">
              <button type="submit" className="btn primary heroSubmit">
                Scan account
              </button>
            </div>
          </form>
        </section>

        <footer className="footer">
          <div className="footerGrid">
            <div className="footerBrand">
              <div className="footerBrandName">Orbit<span className="brandNameAccent">way</span></div>
              <p>A non-custodial account health, cleanup, and locked XLM recovery tool for Stellar.</p>
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
          <div className="footerBottom">© 2026 Orbitway. Account health, reserve recovery, and safe-exit infrastructure for Stellar.</div>
        </footer>
      </main>
    </div>
  );
}

function formatXlmCompact(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unable to verify";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value) + " XLM";
}

function formatEstimatedXlm(value: number): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: value < 10 ? 1 : 0,
    maximumFractionDigits: 2,
  }).format(value) + " XLM";
}

type LiveStatsSnapshot = {
  testnetClosedCount: number;
  mainnetClosedCount: number;
  recoveredXlmTotal: number;
  updatedAt: string | null;
};

type LiveStatsEventKind = "cleanup" | "close";
type LiveStatsNetwork = "testnet" | "mainnet";

type LiveStatsEventInput = {
  id: string;
  kind: LiveStatsEventKind;
  network: LiveStatsNetwork;
  recoveredXlm?: number;
};

const EMPTY_LIVE_STATS: LiveStatsSnapshot = {
  testnetClosedCount: 0,
  mainnetClosedCount: 0,
  recoveredXlmTotal: 0,
  updatedAt: null,
};

type LiveStatsState = {
  snapshot: LiveStatsSnapshot;
  loading: boolean;
  stale: boolean;
  error: string | null;
  lastFetchedAt: number | null;
};

type LiveStatsController = LiveStatsState & {
  refresh: () => Promise<void>;
  recordEvent: (event: LiveStatsEventInput) => Promise<LiveStatsSnapshot | null>;
};

function formatLiveStatsRecency(updatedAt: string | null): string {
  if (!updatedAt) return "No updates yet";
  const time = Date.parse(updatedAt);
  if (!Number.isFinite(time)) return "Recently updated";
  const diffMs = Date.now() - time;
  if (diffMs < 60_000) return "Updated just now";
  const diffMinutes = Math.max(1, Math.round(diffMs / 60_000));
  if (diffMinutes < 60) return `Updated ${diffMinutes}m ago`;
  const diffHours = Math.max(1, Math.round(diffMinutes / 60));
  if (diffHours < 24) return `Updated ${diffHours}h ago`;
  const diffDays = Math.max(1, Math.round(diffHours / 24));
  return `Updated ${diffDays}d ago`;
}

function formatLiveStatsValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const compact = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
  return compact;
}

function useLiveStats(): LiveStatsController {
  const [snapshot, setSnapshot] = useState<LiveStatsSnapshot>(EMPTY_LIVE_STATS);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const hasLoadedOnceRef = useRef(false);

  const refresh = useCallback(async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    if (hasLoadedOnceRef.current) {
      setStale(false);
      setError(null);
      setLoading(true);
    } else {
      setLoading(true);
    }
    try {
      const res = await fetch("/api/stats/live", { signal: controller.signal });
      const text = await res.text();
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { message?: string };
          if (parsed.message) message = parsed.message;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }
      const parsed = JSON.parse(text) as Partial<LiveStatsSnapshot>;
      setSnapshot({
        testnetClosedCount: Number.isFinite(parsed.testnetClosedCount) ? Math.max(0, Math.trunc(Number(parsed.testnetClosedCount))) : 0,
        mainnetClosedCount: Number.isFinite(parsed.mainnetClosedCount) ? Math.max(0, Math.trunc(Number(parsed.mainnetClosedCount))) : 0,
        recoveredXlmTotal: Number.isFinite(parsed.recoveredXlmTotal) ? Math.max(0, Number(parsed.recoveredXlmTotal)) : 0,
        updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim().length > 0 ? parsed.updatedAt : null,
      });
      setLastFetchedAt(Date.now());
      hasLoadedOnceRef.current = true;
      setHasLoadedOnce(true);
      setStale(false);
      setError(null);
    } catch (err) {
      hasLoadedOnceRef.current = true;
      setHasLoadedOnce(true);
      setStale(true);
      setError(err instanceof Error ? err.message : "Live stats unavailable");
    } finally {
      setLoading(false);
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 4 * 60 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const recordEvent = useCallback(async (event: LiveStatsEventInput) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch("/api/stats/live/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { message?: string };
          if (parsed.message) message = parsed.message;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }
      const parsed = JSON.parse(text) as Partial<LiveStatsSnapshot>;
      const nextSnapshot: LiveStatsSnapshot = {
        testnetClosedCount: Number.isFinite(parsed.testnetClosedCount) ? Math.max(0, Math.trunc(Number(parsed.testnetClosedCount))) : 0,
        mainnetClosedCount: Number.isFinite(parsed.mainnetClosedCount) ? Math.max(0, Math.trunc(Number(parsed.mainnetClosedCount))) : 0,
        recoveredXlmTotal: Number.isFinite(parsed.recoveredXlmTotal) ? Math.max(0, Number(parsed.recoveredXlmTotal)) : 0,
        updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim().length > 0 ? parsed.updatedAt : null,
      };
      setSnapshot(nextSnapshot);
      setLastFetchedAt(Date.now());
      setHasLoadedOnce(true);
      setStale(false);
      setError(null);
      return nextSnapshot;
    } catch (err) {
      setStale(true);
      setError(err instanceof Error ? err.message : "Live stats event recording failed");
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  return {
    snapshot,
    loading: loading && !hasLoadedOnce,
    stale,
    error,
    lastFetchedAt,
    refresh,
    recordEvent,
  };
}

function LiveStatsPanel({
  stats,
  compact = false,
  className = "",
}: {
  stats: LiveStatsState;
  compact?: boolean;
  className?: string;
}) {
  const isEmpty =
    stats.snapshot.testnetClosedCount === 0 &&
    stats.snapshot.mainnetClosedCount === 0 &&
    stats.snapshot.recoveredXlmTotal === 0;
  const title =
    stats.loading && !stats.lastFetchedAt
      ? "Loading live stats"
      : stats.stale
        ? "Live stats stale"
        : isEmpty
          ? "Waiting for activity"
          : "Live stats";
  const subtitle =
    stats.loading && !stats.lastFetchedAt
      ? "Syncing the first snapshot."
      : stats.stale
        ? stats.error
          ? `Showing last known snapshot · ${stats.error}`
          : "Showing last known snapshot."
        : isEmpty
          ? "No confirmed events yet."
          : formatLiveStatsRecency(stats.snapshot.updatedAt);
  const liveStateLabel = stats.stale ? "Stale" : stats.loading && !stats.lastFetchedAt ? "Syncing" : "Live";

  if (compact) {
    return (
      <aside
        className={`liveStatsCard liveStatsCard--compact${stats.stale ? " liveStatsCard--stale" : ""}${className ? ` ${className}` : ""}`}
        aria-label="Live stats"
      >
        <div className="liveStatsCompactHeader">
          <div className={`liveStatsCardStatus liveStatsCardStatus--${stats.stale ? "stale" : stats.loading && !stats.lastFetchedAt ? "loading" : "live"}`}>
            <span aria-hidden="true" />
            <strong>Live stats</strong>
          </div>
        </div>
        <div className="liveStatsCardRows">
          <div className="liveStatsMetric">
            <span>Testnet closed</span>
            <strong>{stats.snapshot.testnetClosedCount}</strong>
          </div>
          <div className="liveStatsMetric">
            <span>Mainnet closed</span>
            <strong>{stats.snapshot.mainnetClosedCount}</strong>
          </div>
          <div className="liveStatsMetric liveStatsMetric--accent">
            <span>Recovered XLM</span>
            <strong>{formatLiveStatsValue(stats.snapshot.recoveredXlmTotal)}</strong>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={`liveStatsCard${stats.stale ? " liveStatsCard--stale" : ""}${className ? ` ${className}` : ""}`}
      aria-label="Live stats"
    >
      <div className="liveStatsCardHeader">
        <div className={`liveStatsCardStatus liveStatsCardStatus--${stats.stale ? "stale" : stats.loading && !stats.lastFetchedAt ? "loading" : "live"}`}>
          <span aria-hidden="true" />
          <strong>{liveStateLabel}</strong>
        </div>
        <div className="liveStatsCardTitleBlock">
          <span className="liveStatsCardEyebrow">Live stats</span>
          <strong>{title}</strong>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className="liveStatsCardRows">
        <div className="liveStatsMetric">
          <span>Testnet closed</span>
          <strong>{stats.snapshot.testnetClosedCount}</strong>
        </div>
        <div className="liveStatsMetric">
          <span>Mainnet closed</span>
          <strong>{stats.snapshot.mainnetClosedCount}</strong>
        </div>
        <div className="liveStatsMetric liveStatsMetric--accent">
          <span>Value recovered</span>
          <strong>{formatLiveStatsValue(stats.snapshot.recoveredXlmTotal)}</strong>
        </div>
      </div>
      <div className="liveStatsCardFooter">
        <span>{stats.snapshot.updatedAt ? formatLiveStatsRecency(stats.snapshot.updatedAt) : "Updated after the next successful action"}</span>
        <span>{stats.lastFetchedAt ? "4h refresh cadence" : "Awaiting first refresh"}</span>
      </div>
    </aside>
  );
}

function AppShell({ liveStats }: { liveStats: LiveStatsController }) {
  const [activeSection, setActiveSection] = useState<AppSection>("scan");
  const [reviewTab, setReviewTab] = useState<ReviewTab>("recoverable");
  const [mergeDestinationMode, setMergeDestinationMode] = useState<"wallet" | "exchange" | "unsure">("wallet");
  const [network, setNetwork] = useState<UiNetwork>("testnet");
  const [source, setSource] = useState(() => new URLSearchParams(window.location.search).get("account") ?? "");
  const [destination, setDestination] = useState("");
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>(() => loadWatchlist());
  const [destinationModalOpen, setDestinationModalOpen] = useState(false);
  const [destinationDraft, setDestinationDraft] = useState("");
  const [didAutoloadQueryAccount, setDidAutoloadQueryAccount] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeAcknowledgedDestination, setMergeAcknowledgedDestination] = useState<string | null>(null);
  const [mergeAcknowledgedIrreversible, setMergeAcknowledgedIrreversible] = useState(false);
  const [trustlineSummary, setTrustlineSummary] = useState<TrustlineCleanupSummary | null>(null);
  const [cleanupFocusStep, setCleanupFocusStep] = useState<CleanupStepId | null>(null);
  const [cleanupReviewStep, setCleanupReviewStep] = useState<CleanupStepId | null>(null);
  const [cleanupTrustlinePlannerOpen, setCleanupTrustlinePlannerOpen] = useState(false);
  const cleanupStepRefs = useRef<Partial<Record<CleanupStepId, HTMLElement | null>>>({});

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
    if (!actionSuccess) return;
    const timeout = window.setTimeout(() => setActionSuccess(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [actionSuccess]);

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
        setActiveSection("review");
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
    setCleanupTrustlinePlannerOpen(false);
    await scanAccount(source.trim(), network);
  }, [source, network, scanAccount]);

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
        const recoveredXlm =
          code === "OPEN_OFFERS"
            ? (health.openPositions?.sdexOffers?.length ?? 0) * BASE_RESERVE_XLM
            : code === "DATA_ENTRIES"
              ? ((health.checklist.find((row) => row.id === "classic_data_entries")?.status === "pass" ? 0 : 2) * BASE_RESERVE_XLM)
              : code === "SPONSORING_OTHER_ACCOUNTS"
                ? (health.classicAccount?.sponsorships.sponsoringCount ?? 0) * BASE_RESERVE_XLM
                : code === "MULTISIG_OR_EXTRA_SIGNERS"
                  ? (health.classicAccount?.signers?.extra?.length ?? 0) * BASE_RESERVE_XLM
                  : code === "TRUSTLINES_OR_ASSET_BALANCES"
                    ? (trustlineSummary?.empty ?? 0) * BASE_RESERVE_XLM
                    : 0;
        const result = await runClassicBlockerFix(code, {
          accountId: id,
          horizonUrl: health.horizonUrl,
          network,
          signSubmit: signSubmitClassicBatch,
          lpShares: health.openPositions?.liquidityPoolShares,
        });
        setActionSuccess(result.message);
        await liveStats.recordEvent({
          id: result.hash,
          kind: "cleanup",
          network,
          recoveredXlm,
        });
        await refreshHealth();
      } catch (e) {
        setWalletError(formatWalletError(e));
      } finally {
        setWalletBusy(false);
      }
    },
    [health, liveStats, network, refreshHealth, signSubmitClassicBatch, source, trustlineSummary, walletAddress],
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
      await liveStats.recordEvent({
        id: hash,
        kind: "close",
        network,
        recoveredXlm: typeof health?.nativeBalanceXlm === "number" ? health.nativeBalanceXlm : 0,
      });
      await refreshHealth();
    } catch (e) {
      setWalletError(formatWalletError(e));
    } finally {
      setMergeBusy(false);
    }
  }, [health, liveStats, network, source, destination, walletAddress, refreshHealth, signSubmitClassicBatch]);

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
      setActionSuccess("This address has been saved.");
    },
    [],
  );

  useEffect(() => {
    if (activeSection !== "clean" || !cleanupFocusStep) return;
    const node = cleanupStepRefs.current[cleanupFocusStep];
    if (!node) return;
    window.requestAnimationFrame(() => {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [activeSection, cleanupFocusStep]);

  useEffect(() => {
    if (didAutoloadQueryAccount) return;
    setDidAutoloadQueryAccount(true);
    if (!isValidClassicAddress(sourceTrim)) return;
    void scanAccount(sourceTrim, network);
  }, [didAutoloadQueryAccount, network, scanAccount, sourceTrim]);

  const scanStatus = health ? "Scan complete" : "Enter or load an address";
  const reviewStatus = sourceTrim ? (isSaved ? "Account reviewed" : "Review account") : "Account health and blockers";
  const cleanStatus = !sourceTrim || !health ? "Locked" : readyByHealth ? "No cleanup required" : "Step-by-step cleanup plan";
  const mergeStatus = !sourceTrim || !health ? "Locked" : readyByHealth ? "Ready for final review" : "Not ready for merge";
  const sectionNavItems: Array<{ id: AppSection; label: string; detail: string; index: number }> = [
    { id: "scan", label: "Scan", detail: scanStatus, index: 1 },
    { id: "review", label: "Review", detail: reviewStatus, index: 2 },
    { id: "clean", label: "Clean", detail: cleanStatus, index: 3 },
    { id: "merge", label: "Merge", detail: mergeStatus, index: 4 },
  ];
  const accountStateLabel = !health ? "Awaiting scan" : health.canDemolish ? "Ready for merge" : "Not ready for merge";
  const closeReadinessLabel =
    health?.canDemolish && destOk
      ? "Ready to merge"
      : !destOk
        ? "Destination missing"
        : blocking.length > 0
          ? "Not ready for merge"
          : "Review first";
  const compactTrustlineCount = trustlineSummary?.total ?? (trustlineChecklistRow?.status === "pass" ? 0 : 1);
  const sourceLabel = sourceTrim ? formatAccount(sourceTrim) : "GTEST1MN...2345TTTT";
  const networkLabel = network === "mainnet" ? "Mainnet" : "Testnet";
  const openOffersCount = health?.openPositions?.sdexOffers?.length ?? 4;
  const trustlineCount = trustlineSummary?.total ?? (health?.checklist.find((row) => row.id === "classic_trustlines")?.status === "pass" ? 0 : 3);
  const dataEntryCount = health?.checklist.find((row) => row.id === "classic_data_entries")?.status === "pass" ? 0 : 2;
  const signerCount = health?.classicAccount?.signers?.extra?.length ?? 0;
  const thresholdState = health?.classicAccount?.thresholds.mergeFriendly ? "Merge-friendly" : "Needs review";
  const allowanceCount = health?.openPositions?.defiProtocols?.length ?? 1;
  const sponsorshipCount = health?.classicAccount?.sponsorships.sponsoringCount ?? 0;
  const sponsorshipEntryCount = health?.classicAccount?.sponsorships.entries?.length ?? 0;
  const hasExtraSigners = signerCount > 0;
  const thresholdsNeedCleanup = !health?.classicAccount?.thresholds.mergeFriendly;
  const controlNeedsCleanup = hasExtraSigners || thresholdsNeedCleanup;
  const defiReviewCount = health?.openPositions?.defiProtocols?.length ?? 0;
  const trustlineCleanupTarget: CleanupStepId = trustlineSummary?.funded ? "route-asset-balances" : "remove-trustlines";
  const trustlineHasBalances = (trustlineSummary?.funded ?? 0) > 0;
  const sponsoredReserveXlm = sponsorshipCount * BASE_RESERVE_XLM;
  const estimatedRecoverableReserveXlm =
    (trustlineCount + openOffersCount + dataEntryCount + sponsorshipCount) * BASE_RESERVE_XLM;
  const reserveReleaseLabel = formatXlmCompact(estimatedRecoverableReserveXlm);
  const recoverableValueCards = [
      {
        title: "Native XLM balance",
        detail: `${typeof health?.nativeBalanceXlm === "number" ? health.nativeBalanceXlm.toFixed(2) : "15.42"} XLM available`,
        body: "Spendable balance routed during merge.",
        metaLeft: `+${typeof health?.nativeBalanceXlm === "number" ? health.nativeBalanceXlm.toFixed(2) : "15.42"} XLM after merge`,
        metaRight: "Not a blocker",
        badge: "Supported",
        tone: "value" as const,
        metaLeftTone: "value" as const,
        metaRightTone: "muted" as const,
        actionLabel: "Not a blocker",
      },
      {
        title: "Base reserve",
        detail: "1.00 XLM locked",
        body: "Minimum reserve released on ACCOUNT_MERGE.",
        metaLeft: "+1.00 XLM after merge",
        metaRight: "Not a blocker",
        badge: "Supported",
        tone: "value" as const,
        metaLeftTone: "value" as const,
        metaRightTone: "muted" as const,
        actionLabel: "Not a blocker",
      },
      {
        title: "Trustline reserves",
        detail: `${trustlineCount} trustline${trustlineCount === 1 ? "" : "s"} × 0.50 XLM`,
        body: trustlineCount > 0
          ? trustlineSummary?.funded
            ? "Balances must move first, then the empty line can be removed."
            : "Empty trustlines can be removed to release reserve."
          : "No trustline reserve is currently blocking this account.",
        metaLeft: `+${(trustlineCount * 0.5).toFixed(2)} XLM unlockable`,
        metaRight: trustlineCount > 0 ? "Action: Remove trustlines" : "Not a blocker",
        badge: "Supported",
        tone: "value" as const,
        metaLeftTone: "value" as const,
        metaRightTone: trustlineCount > 0 ? "action" as const : "muted" as const,
        actionLabel: trustlineCount > 0 ? (trustlineSummary?.funded ? "Route balances" : "Remove trustlines") : "Not a blocker",
        actionTarget:
          trustlineCount > 0 ? { section: "clean" as const, stepId: trustlineCleanupTarget } : undefined,
      },
      {
        title: "Open offer reserves",
        detail: `${openOffersCount} open offer${openOffersCount === 1 ? "" : "s"} × 0.50 XLM`,
        body: openOffersCount > 0 ? "Each open offer locks 0.50 XLM until cancelled." : "No open offers are currently blocking this account.",
        metaLeft: `+${(openOffersCount * 0.5).toFixed(2)} XLM unlockable`,
        metaRight: openOffersCount > 0 ? "Action: Cancel open offers" : "Not a blocker",
        badge: "Supported",
        tone: "value" as const,
        metaLeftTone: "value" as const,
        metaRightTone: openOffersCount > 0 ? "action" as const : "muted" as const,
        actionLabel: openOffersCount > 0 ? "Cancel open offers" : "Not a blocker",
        actionTarget: openOffersCount > 0 ? { section: "clean" as const, stepId: "cancel-open-offers" as const } : undefined,
      },
      {
        title: "Sponsored reserves",
        detail: `${sponsorshipEntryCount} sponsored entr${sponsorshipEntryCount === 1 ? "y" : "ies"}`,
        body:
          sponsorshipCount > 0
            ? "Sponsored ledger entries still hold reserve until revoked."
            : "No sponsored reserves are currently locking this account.",
        metaLeft: sponsorshipCount > 0 ? `~${formatEstimatedXlm(sponsoredReserveXlm)} unlockable` : "Review sponsorships",
        metaRight: sponsorshipCount > 0 ? "Action: Revoke sponsorships" : "Not a blocker",
        badge: sponsorshipCount > 0 ? "Supported" : "Manual review",
        tone: sponsorshipCount > 0 ? ("warn" as const) : ("value" as const),
        metaLeftTone: "value" as const,
        metaRightTone: sponsorshipCount > 0 ? ("action" as const) : ("muted" as const),
        actionLabel: sponsorshipCount > 0 ? "Revoke sponsorships" : "Not a blocker",
        actionTarget: sponsorshipCount > 0 ? { section: "clean" as const, stepId: "revoke-sponsorships" as const } : undefined,
      },
      {
        title: "Data entry reserves",
        detail: `${dataEntryCount} data entr${dataEntryCount > 1 ? "ies" : "y"} × 0.50 XLM`,
        body: dataEntryCount > 0 ? "Each data entry locks 0.50 XLM until cleared." : "No data entries are currently blocking this account.",
        metaLeft: `+${(dataEntryCount * 0.5).toFixed(2)} XLM unlockable`,
        metaRight: dataEntryCount > 0 ? "Signing: Required" : "Not a blocker",
        badge: "Supported",
        tone: "value" as const,
        metaLeftTone: "value" as const,
        metaRightTone: dataEntryCount > 0 ? "muted" as const : "muted" as const,
        actionLabel: dataEntryCount > 0 ? "Clear data entries" : "Not a blocker",
        actionTarget: dataEntryCount > 0 ? { section: "clean" as const, stepId: "clear-data-entries" as const } : undefined,
      },
      {
        title: hasExtraSigners ? "Extra signer reserve" : "Threshold reserve",
        detail: hasExtraSigners
          ? `${signerCount} extra signer${signerCount === 1 ? "" : "s"} × 0.50 XLM`
          : "Merge-friendly thresholds × 0.50 XLM",
        body: hasExtraSigners
          ? "Extra signers and rules lock reserve until adjusted."
          : thresholdsNeedCleanup
            ? "Signature thresholds still need to be merge-friendly."
            : "No signer cleanup is currently blocking this account.",
        metaLeft: `+${(signerCount * 0.5).toFixed(2)} XLM unlockable`,
        metaRight: hasExtraSigners ? "Action: Remove signer" : thresholdsNeedCleanup ? "Action: Set thresholds" : "Not a blocker",
        badge: hasExtraSigners ? "Manual review" : thresholdsNeedCleanup ? "Supported" : "Manual review",
        tone: "warn" as const,
        metaLeftTone: "value" as const,
        metaRightTone: hasExtraSigners || thresholdsNeedCleanup ? ("action" as const) : ("muted" as const),
        actionLabel: hasExtraSigners ? "Set account control" : thresholdsNeedCleanup ? "Set thresholds" : "Not a blocker",
        actionTarget: hasExtraSigners || thresholdsNeedCleanup ? { section: "clean" as const, stepId: "set-account-control" as const } : undefined,
      },
    ] satisfies Array<{
      title: string;
      detail: string;
      body: string;
      metaLeft: string;
      metaRight: string;
      badge: string;
      tone: "value" | "state" | "warn";
      metaLeftTone: "value" | "action" | "muted";
      metaRightTone: "value" | "action" | "muted";
      actionLabel: string;
      actionTarget?: { section: AppSection; stepId?: CleanupStepId };
    }>;

  const cleanupBlockerCards = [
      {
        title: "Open offers",
        detail: `${openOffersCount} open offer${openOffersCount === 1 ? "" : "s"} active`,
        body: openOffersCount > 0 ? "Open offers block trustline removal and account merge." : "Not a blocker for this account.",
        metaLeft: `+${(openOffersCount * 0.5).toFixed(2)} XLM unlockable`,
        metaRight: openOffersCount > 0 ? "Action: Cancel all offers" : "Not a blocker",
        badge: "Supported",
        tone: "warn" as const,
        metaLeftTone: "value" as const,
        metaRightTone: openOffersCount > 0 ? "action" as const : "muted" as const,
        actionLabel: openOffersCount > 0 ? "Cancel open offers" : "Not a blocker",
        actionTarget: openOffersCount > 0 ? { section: "clean" as const, stepId: "cancel-open-offers" as const } : undefined,
        visible: openOffersCount > 0,
      },
      {
        title: "Trustlines",
        detail: `${trustlineCount} trustline${trustlineCount === 1 ? "" : "s"} - USDC, AQUA, yXLM`,
        body:
          trustlineCount > 0
            ? trustlineSummary?.funded
              ? "Route balances before removing the trustline."
              : "Empty trustlines can be removed once balances clear."
            : "Not a blocker for this account.",
        metaLeft: `+${(trustlineCount * 0.5).toFixed(2)} XLM unlockable`,
        metaRight: trustlineCount > 0 ? "Signing: Required" : "Not a blocker",
        badge: "Supported",
        tone: "warn" as const,
        metaLeftTone: "value" as const,
        metaRightTone: trustlineCount > 0 ? "muted" as const : "muted" as const,
        actionLabel: trustlineCount > 0 ? (trustlineSummary?.funded ? "Route balances" : "Remove trustlines") : "Not a blocker",
        actionTarget: trustlineCount > 0 ? { section: "clean" as const, stepId: trustlineCleanupTarget } : undefined,
        visible: trustlineCount > 0,
      },
      {
        title: "Sponsored reserves",
        detail: `${sponsorshipEntryCount} sponsored entr${sponsorshipEntryCount === 1 ? "y" : "ies"}`,
        body: sponsorshipEntryCount > 0
          ? "Sponsored ledger entries still hold reserve until revoked."
          : "Not a blocker for this account.",
        metaLeft: sponsorshipCount > 0 ? `~${formatEstimatedXlm(sponsorshipCount * BASE_RESERVE_XLM)} unlockable` : "Review sponsorships",
        metaRight: sponsorshipCount > 0 ? "Action: Revoke sponsorships" : "Not a blocker",
        badge: sponsorshipCount > 0 ? "Supported" : "Manual review",
        tone: "warn" as const,
        metaLeftTone: "value" as const,
        metaRightTone: sponsorshipCount > 0 ? "action" as const : "muted" as const,
        actionLabel: sponsorshipCount > 0 ? "Revoke sponsorships" : "Not a blocker",
        actionTarget: sponsorshipCount > 0 ? { section: "clean" as const, stepId: "revoke-sponsorships" as const } : undefined,
        visible: sponsorshipCount > 0 || sponsorshipEntryCount > 0,
      },
      {
        title: "Data entries",
        detail: `${dataEntryCount} entries: app_name, session_key`,
        body: dataEntryCount > 0 ? "Data entries lock reserve until cleared." : "Not a blocker for this account.",
        metaLeft: `+${(dataEntryCount * 0.5).toFixed(2)} XLM unlockable`,
        metaRight: dataEntryCount > 0 ? "Signing: Required" : "Not a blocker",
        badge: "Supported",
        tone: "warn" as const,
        metaLeftTone: "value" as const,
        metaRightTone: dataEntryCount > 0 ? "muted" as const : "muted" as const,
        actionLabel: dataEntryCount > 0 ? "Clear data entries" : "Not a blocker",
        actionTarget: dataEntryCount > 0 ? { section: "clean" as const, stepId: "clear-data-entries" as const } : undefined,
        visible: dataEntryCount > 0,
      },
    ] satisfies Array<{
      title: string;
      detail: string;
      body: string;
      metaLeft: string;
      metaRight: string;
      badge: string;
      tone: "value" | "state" | "warn";
      metaLeftTone: "value" | "action" | "muted";
      metaRightTone: "value" | "action" | "muted";
      actionLabel: string;
      actionTarget?: { section: AppSection; stepId?: CleanupStepId };
      visible?: boolean;
    }>;

  const accountControlCards = [
      {
        title: hasExtraSigners ? "Extra signer / thresholds" : "Threshold settings",
        detail: hasExtraSigners ? `${signerCount} extra signer: GBXYZ...4ABCD (weight 1)` : "Merge-friendly thresholds required",
        body: controlNeedsCleanup
          ? hasExtraSigners
            ? "Account control still needs a merge-friendly signer and threshold setup."
            : "Account control still needs merge-friendly threshold setup."
          : "Account control is already merge-friendly.",
        metaLeft: hasExtraSigners ? "Action: Set merge-friendly rules" : thresholdsNeedCleanup ? "Action: Set thresholds" : "Not a blocker",
        metaRight: controlNeedsCleanup ? "Signing: Required" : "Not a blocker",
        badge: "Manual review",
        tone: "warn" as const,
        metaLeftTone: "action" as const,
        metaRightTone: controlNeedsCleanup ? "muted" as const : "muted" as const,
        actionLabel: hasExtraSigners ? "Set account control" : thresholdsNeedCleanup ? "Set thresholds" : "Not a blocker",
        actionTarget: controlNeedsCleanup ? { section: "clean" as const, stepId: "set-account-control" as const } : undefined,
        visible: controlNeedsCleanup,
      },
      {
        title: "Threshold settings",
        detail: `Low: ${health?.classicAccount?.thresholds.low ?? 1} • Medium: ${health?.classicAccount?.thresholds.medium ?? 2} • High: ${health?.classicAccount?.thresholds.high ?? 2} • Master weight: ${health?.classicAccount?.thresholds.mergeFriendly ? 1 : 0}`,
        body: health?.classicAccount?.thresholds.mergeFriendly ? "Not a blocker for this account." : "Thresholds determine which operations need more signer weight.",
        metaLeft: thresholdState,
        metaRight: health?.classicAccount?.thresholds.mergeFriendly ? "Not a blocker" : "Signing: Not required",
        badge: "Supported",
        tone: "value" as const,
        metaLeftTone: "value" as const,
        metaRightTone: "muted" as const,
        actionLabel: health?.classicAccount?.thresholds.mergeFriendly ? "Not a blocker" : "Set merge-friendly rules",
        actionTarget: health?.classicAccount?.thresholds.mergeFriendly ? undefined : { section: "clean" as const, stepId: "set-account-control" as const },
        visible: !health?.classicAccount?.thresholds.mergeFriendly,
      },
    ] satisfies Array<{
      title: string;
      detail: string;
      body: string;
      metaLeft: string;
      metaRight: string;
      badge: string;
      tone: "value" | "state" | "warn";
      metaLeftTone: "value" | "action" | "muted";
      metaRightTone: "value" | "action" | "muted";
      actionLabel: string;
      actionTarget?: { section: AppSection; stepId?: CleanupStepId };
      visible?: boolean;
    }>;

  const defiReviewCards = [
      {
        title: "USDC SAC allowance",
        detail: `${allowanceCount * 100}.00 USDC approval to DEX contract CDEX...7890`,
        body: defiReviewCount > 0 ? "Soroban allowance is not yet supported by Orbitway." : "Not a blocker for this account.",
        metaLeft: defiReviewCount > 0 ? "Action: Review Soroban state" : "Not a blocker",
        metaRight: defiReviewCount > 0 ? "Signing: Not required" : "Not a blocker",
        badge: "Visible only",
        tone: "warn" as const,
        metaLeftTone: "action" as const,
        metaRightTone: "muted" as const,
        actionLabel: defiReviewCount > 0 ? "Review Soroban state" : "Not a blocker",
        actionTarget: defiReviewCount > 0 ? { section: "clean" as const, stepId: "review-soroban-state" as const } : undefined,
        visible: defiReviewCount > 0,
      },
    ] satisfies Array<{
      title: string;
      detail: string;
      body: string;
      metaLeft: string;
      metaRight: string;
      badge: string;
      tone: "value" | "state" | "warn";
      metaLeftTone: "value" | "action" | "muted";
      metaRightTone: "value" | "action" | "muted";
      actionLabel: string;
      actionTarget?: { section: AppSection; stepId?: CleanupStepId };
      visible?: boolean;
    }>;

  const reviewTabContent = {
    recoverable: recoverableValueCards,
    blockers: cleanupBlockerCards.filter((card) => card.visible !== false),
    control: accountControlCards.filter((card) => card.visible !== false),
    defi: defiReviewCards.filter((card) => card.visible !== false),
  } satisfies Record<
    ReviewTab,
    Array<{
      title: string;
      detail: string;
      body: string;
      metaLeft: string;
      metaRight: string;
      badge: string;
      tone: "value" | "state" | "warn";
      metaLeftTone: "value" | "action" | "muted";
      metaRightTone: "value" | "action" | "muted";
      actionLabel: string;
      actionTarget?: { section: AppSection; stepId?: CleanupStepId };
      visible?: boolean;
    }>
  >;
  const reviewTabs = [
    { id: "recoverable" as const, label: "Recoverable value", count: reviewTabContent.recoverable.length, hint: "XLM that may unlock reserve or recover value" },
    { id: "blockers" as const, label: "Cleanup blockers", count: reviewTabContent.blockers.length, hint: "Objects that are actively blocking cleanup or merge" },
    { id: "control" as const, label: "Account control", count: reviewTabContent.control.length, hint: "Signer and threshold setup" },
    { id: "defi" as const, label: "Soroban / DeFi", count: reviewTabContent.defi.length, hint: "SAC balances, allowances, DeFi positions" },
  ];
  const cleanupSteps = [
    {
      id: "cancel-open-offers" as CleanupStepId,
      num: "1",
      title: "Cancel open offers",
      detail: `${openOffersCount} open offers active`,
      why: "Offers must be cancelled before related trustlines can be removed.",
      result: "Offer reserves released. Trustline cleanup unlocked.",
      benefit: `+${(openOffersCount * 0.5).toFixed(2)} XLM unlockable`,
      state: openOffersCount > 0 ? "Ready" : "Done",
      visible: openOffersCount > 0,
      actionLabel: openOffersCount > 0 ? "Review transaction" : "No open offers",
      actionMode: openOffersCount > 0 ? ("tx" as const) : ("disabled" as const),
      onClick: () => void resolveClassicBlocker("OPEN_OFFERS"),
    },
    {
      id: "route-asset-balances" as CleanupStepId,
      num: "2",
      title: "Route asset balances",
      detail: `${trustlineCount} trustlines with non-zero balance: USDC (45.00), AQUA (120.00)`,
      why: "Asset balances must be routed before trustlines can be removed.",
      result: "Balances routed. Trustline cleanup unlocked.",
      benefit: `+${(trustlineCount * 0.6).toFixed(2)} XLM routable`,
      state: trustlineHasBalances ? "Ready" : "Blocked",
      visible: trustlineHasBalances,
      actionLabel: "Open trustline planner",
      actionMode: "planner" as const,
      onClick: () => setCleanupTrustlinePlannerOpen(true),
      blockedBy: "Trustline planner",
    },
    {
      id: "revoke-sponsorships" as CleanupStepId,
      num: "3",
      title: "Revoke sponsorships",
      detail: sponsorshipEntryCount > 0 ? `${sponsorshipEntryCount} sponsored entr${sponsorshipEntryCount === 1 ? "y" : "ies"}` : "Sponsored reserve relationships",
      why: "Sponsored entries keep reserve locked until their sponsorships are removed.",
      result: "Sponsored reserves released.",
      benefit: sponsorshipCount > 0 ? `+${formatEstimatedXlm(sponsorshipCount * BASE_RESERVE_XLM)} unlockable` : "Review only",
      state: sponsorshipCount > 0 ? "Ready" : "Manual review",
      visible: sponsorshipEntryCount > 0 || sponsorshipCount > 0,
      actionLabel: sponsorshipCount > 0 ? "Review sponsorship transaction" : "Manual review",
      actionMode: sponsorshipCount > 0 ? ("tx" as const) : ("manual" as const),
      onClick: () => void resolveClassicBlocker("SPONSORING_OTHER_ACCOUNTS"),
    },
    {
      id: "remove-trustlines" as CleanupStepId,
      num: "4",
      title: "Remove trustlines",
      detail: `${trustlineCount} trustlines - 1 zero-balance, 2 pending balance route`,
      why: "Trustline reserve cannot be released until balances move out.",
      result: "Trustlines removed. Reserve recovered.",
      benefit: `+${(trustlineCount * 0.5).toFixed(2)} XLM unlockable`,
      state: trustlineCount > 0 ? "Blocked" : "Done",
      visible: trustlineCount > 0,
      actionLabel: "Open trustline planner",
      actionMode: "planner" as const,
      onClick: () => setCleanupTrustlinePlannerOpen(true),
      blockedBy: "Trustline planner",
    },
    {
      id: "clear-data-entries" as CleanupStepId,
      num: "5",
      title: "Clear data entries",
      detail: `${dataEntryCount} data entries: app_name, session_key`,
      why: "Data entries lock reserve and must be cleared before merge.",
      result: "Data entry reserves released.",
      benefit: `+${(dataEntryCount * 0.5).toFixed(2)} XLM unlockable`,
      state: dataEntryCount > 0 ? "Ready" : "Done",
      visible: dataEntryCount > 0,
      actionLabel: dataEntryCount > 0 ? "Review transaction" : "No data entries",
      actionMode: dataEntryCount > 0 ? ("tx" as const) : ("disabled" as const),
      onClick: () => void resolveClassicBlocker("DATA_ENTRIES"),
    },
      {
        id: "set-account-control" as CleanupStepId,
        num: "6",
        title: hasExtraSigners ? "Set merge-friendly account control" : "Set merge-friendly thresholds",
        detail: hasExtraSigners ? `${signerCount} extra signer: GBXYZ...4ABCD (weight 1)` : "Thresholds need to be merge-friendly",
        why: hasExtraSigners
          ? "Extra signer may block authorized account merge. All required signers must approve."
          : "Thresholds may still block authorized account merge. Merge-friendly rules must be set.",
        result: hasExtraSigners ? "Signer removed. Merge authority confirmed." : "Thresholds adjusted. Merge authority confirmed.",
        benefit: `+${(signerCount * 0.5).toFixed(2)} XLM unlockable`,
        state: hasExtraSigners ? "Manual review" : thresholdsNeedCleanup ? "Ready" : "Done",
        visible: controlNeedsCleanup,
        actionLabel: hasExtraSigners ? "Set merge-friendly rules" : thresholdsNeedCleanup ? "Set thresholds" : "Not a blocker",
        actionMode: "tx" as const,
        onClick: () => void resolveClassicBlocker("MULTISIG_OR_EXTRA_SIGNERS"),
      },
    {
      id: "review-soroban-state" as CleanupStepId,
      num: "7",
      title: "Review Soroban state",
      detail: "USDC SAC allowance detected - revocation unsupported",
      why: "Unresolved Soroban state may block safe merge.",
      result: "Soroban state resolved or acknowledged as non-blocking.",
      benefit: "No direct XLM impact",
      state: defiReviewCount > 0 ? "Unsupported" : "Done",
      visible: defiReviewCount > 0,
      actionLabel: "Manual review",
      actionMode: "disabled" as const,
      onClick: undefined,
    },
  ];
  const cleanupReviewStepData = cleanupReviewStep ? cleanupSteps.find((step) => step.id === cleanupReviewStep) ?? null : null;
  const mergeDestinationAcknowledged = mergeAcknowledgedDestination === destination.trim() && destOk;
  const mergeChecklist = [
    { label: "No open offers", right: openOffersCount === 0 ? "Ready" : "Cleanup required", tone: openOffersCount === 0 ? "ok" : "fail" },
    { label: "No blocking trustlines", right: trustlineCount === 0 ? "Ready" : "Cleanup required", tone: trustlineCount === 0 ? "ok" : "fail" },
    { label: "No unresolved sponsorship blockers", right: sponsorshipCount === 0 ? "Ready" : "Cleanup required", tone: sponsorshipCount === 0 ? "ok" : "fail" },
    { label: "No unresolved data entries", right: dataEntryCount === 0 ? "Ready" : "Cleanup required", tone: dataEntryCount === 0 ? "ok" : "fail" },
    {
      label: "Signers and thresholds allow merge",
      right: controlNeedsCleanup ? "Cleanup required" : "Ready",
      tone: controlNeedsCleanup ? "fail" : "ok",
    },
    {
      label: "No unsupported Soroban / DeFi blockers",
      right: defiReviewCount === 0 ? "Ready" : "Review only",
      tone: defiReviewCount === 0 ? "ok" : "neutral",
    },
    {
      label: "Destination reviewed",
      right: mergeDestinationAcknowledged ? "Acknowledged" : "Click to acknowledge",
      tone: mergeDestinationAcknowledged ? "ok" : "neutral",
      actionLabel: mergeDestinationAcknowledged ? "Re-check" : "Acknowledge",
      onClick: () => {
        if (!destOk) return;
        setMergeAcknowledgedDestination(destination.trim());
      },
    },
    {
      label: "I understand this action is irreversible",
      right: mergeAcknowledgedIrreversible ? "Acknowledged" : "Click to acknowledge",
      tone: mergeAcknowledgedIrreversible ? "ok" : "neutral",
      actionLabel: mergeAcknowledgedIrreversible ? "Clear" : "Acknowledge",
      onClick: () => setMergeAcknowledgedIrreversible((v) => !v),
    },
  ] as const;
  const mergeChecklistReady =
    openOffersCount === 0 &&
    trustlineCount === 0 &&
    sponsorshipCount === 0 &&
    dataEntryCount === 0 &&
    !controlNeedsCleanup;
  const mergeCanProceed = Boolean(
    health?.canDemolish && destOk && mergeDestinationAcknowledged && mergeAcknowledgedIrreversible && mergeChecklistReady,
  );
  const mergeSummaryRows = [
    ["Source account", sourceLabel],
    ["Destination", mergeDestinationMode === "exchange" ? "Exchange" : mergeDestinationMode === "unsure" ? "Not sure" : "Wallet"],
    ["Recoverable reserve", reserveReleaseLabel],
    ["Estimated payout", typeof health?.nativeBalanceXlm === "number" ? `${health.nativeBalanceXlm.toFixed(2)} XLM` : "23.72 XLM"],
  ] as const;
  const scanSavedAccounts =
    watchlist.length > 0
      ? watchlist.slice(0, 3).map((entry, index) => ({
          title:
            entry.summary ??
            (index === 0 ? "Test account" : index === 1 ? "Exchange reserve" : "Primary wallet"),
          accountId: formatAccount(entry.accountId),
          networkLabel: entry.network,
          status:
            entry.readyToClose === true ? "Healthy" : entry.readyToClose === false ? "Needs cleanup" : "Not ready to close",
          timeLabel:
            entry.lastScannedAt && Number.isFinite(entry.lastScannedAt)
              ? `${Math.max(1, Math.round((Date.now() - entry.lastScannedAt) / 3_600_000))}h ago`
              : "Saved",
          tone: entry.readyToClose === true ? "ok" : entry.readyToClose === false ? "warn" : "neutral",
        }))
      : [
          {
            title: "Test account",
            accountId: "GTEST1MN...45TTTT",
            networkLabel: "testnet",
            status: "Healthy",
            timeLabel: "2d ago",
            tone: "ok" as const,
          },
          {
            title: "Exchange reserve",
            accountId: "GZZZZ4MN...00AAAA",
            networkLabel: "",
            status: "Needs cleanup",
            timeLabel: "1d ago",
            tone: "warn" as const,
          },
          {
            title: "Primary wallet",
            accountId: "GABCDEFG...K67890",
            networkLabel: "",
            status: "Not ready to close",
            timeLabel: "2h ago",
            tone: "warn" as const,
          },
        ];
  const openDestinationModal = useCallback(() => {
    setDestinationDraft(destination);
    setDestinationModalOpen(true);
  }, [destination]);

  const saveDestinationFromModal = useCallback(() => {
    const trimmed = destinationDraft.trim();
    if (!isValidClassicAddress(trimmed)) return;
    setDestination(trimmed);
    setDestinationModalOpen(false);
  }, [destinationDraft]);

  const openWorkflowTarget = useCallback((target?: { section: AppSection; stepId?: CleanupStepId }) => {
    if (!target) return;
    setActiveSection(target.section);
    setCleanupFocusStep(target.section === "clean" ? target.stepId ?? null : null);
  }, []);

  const sponsorshipNeedsAction = checklistById.get("classic_sponsorship")?.status === "fail";
  const nextBestAction = !health
    ? null
    : trustlineChecklistRow?.status === "fail" || (trustlineSummary?.total ?? 0) > 0
      ? {
          eyebrow: "Next best action",
          title: `Resolve ${compactTrustlineCount} token line${compactTrustlineCount === 1 ? "" : "s"}`,
          body: `Unlock approximately ${reserveReleaseLabel} by clearing funded trustlines first.`,
          actionLabel: "Review trustlines",
          tone: "value",
          onClick: () => openWorkflowTarget({ section: "clean", stepId: trustlineCleanupTarget }),
        }
      : sponsorshipNeedsAction
          ? {
              eyebrow: "Next best action",
              title: "Revoke sponsored reserves",
              body: null,
              actionLabel: "Review sponsorships",
              tone: "warn",
              onClick: () => openWorkflowTarget({ section: "clean", stepId: "revoke-sponsorships" }),
          }
      : !destOk
          ? {
              eyebrow: "Next best action",
              title: "Save destination address",
              body: "Merge flow needs a verified destination before final wallet approval.",
              actionLabel: "Save destination",
              tone: "close",
              onClick: openDestinationModal,
            }
          : {
              eyebrow: "Next best action",
              title: "Review final merge flow",
              body: "Required cleanup is clear enough to move into destination and irreversible merge review.",
              actionLabel: "Open merge flow",
              tone: "close",
              onClick: () => setActiveSection("merge"),
            };

  const reviewStats = [
    {
      label: "Account status",
      value: accountStateLabel,
      detail: health?.summary ?? "Read-only scan complete.",
      tone: readyByHealth ? "ok" : "warn",
    },
    {
      label: "Merge readiness",
      value: readyByHealth ? "Ready to merge" : "Not ready for merge",
      detail: closeReadinessLabel,
      tone: readyByHealth ? "ok" : "warn",
    },
    {
      label: "Recoverable reserve",
      value: reserveReleaseLabel,
      detail: "Available XLM that can be unlocked before merge.",
      tone: "value",
    },
    {
      label: "Blockers found",
      value: `${blocking.length}`,
      detail: "Cleanup items that must be resolved in order.",
      tone: blocking.length > 0 ? "warn" : "ok",
    },
    {
      label: "Next safe action",
      value: nextBestAction?.title ?? "Review cleanup",
      detail: nextBestAction?.body?.trim() ? nextBestAction.body : null,
      tone: "accent",
    },
    {
      label: "Wallet",
      value: walletAddress ? "Connected" : "Not connected",
      detail: walletAddress ? formatAccount(walletAddress) : "Connect only when you need to sign.",
      tone: walletAddress ? "ok" : "warn",
    },
  ] as const;

  return (
    <div className="page page--app">
      <main className="workspace workspace--shell">
        <aside className="consoleSidebar">
          <div className="consoleSidebarTop">
            <div className="brand">
              <img className="brandMark" src="/orbitway-logo.png" alt="" />
              <div>
                <div className="brandName">Orbit<span className="brandNameAccent">way</span></div>
                <div className="brandTag">Account health and cleanup</div>
              </div>
            </div>
          </div>

          <nav className="sidebarNav" aria-label="App navigation">
            {sectionNavItems.map(({ id, label, detail, index }) => (
              <button
                key={id}
                type="button"
                className={`sidebarNavButton sidebarNavButton--${id}${activeSection === id ? " sidebarNavButton--active" : ""}`}
                onClick={() => setActiveSection(id as AppSection)}
              >
                <span className="sidebarNavIndex">{index}</span>
                <span className="sidebarNavCopy">
                  <span className="sidebarNavLabel">{label}</span>
                  <span className="sidebarNavMeta">{detail}</span>
                </span>
              </button>
            ))}
          </nav>

          <div className="sidebarBottom">
            {walletAddress && sourceTrim ? (
              <div className="sidebarAccountCard">
                <span className="sidebarSectionLabel">Active account</span>
                <strong>{formatAccount(sourceTrim)}</strong>
                <span>{network === "mainnet" ? "Mainnet" : "Testnet"}</span>
              </div>
            ) : null}
            <LiveStatsPanel stats={liveStats} compact className="liveStatsCard--sidebar" />
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

          <nav className="stageNav" aria-label="Workflow stages">
            {sectionNavItems.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`stageNavItem${activeSection === id ? " stageNavItem--active" : ""}`}
                onClick={() => setActiveSection(id)}
              >
                <span className="stageNavIndex">{sectionNavItems.findIndex((item) => item.id === id) + 1}</span>
                <span className="stageNavLabel">{label}</span>
              </button>
            ))}
          </nav>

          <nav className="mobileSectionNav" aria-label="App sections">
            {sectionNavItems.map(({ id, label, detail }) => (
              <button
                key={id}
                type="button"
                className={`mobileSectionNavButton mobileSectionNavButton--${id}${activeSection === id ? " mobileSectionNavButton--active" : ""}`}
                onClick={() => setActiveSection(id)}
              >
                <span>{label}</span>
                <small>{detail}</small>
              </button>
            ))}
          </nav>

          {actionSuccess ? (
            <div className="appSuccessNotice" role="status" aria-live="polite">
              <span className="appSuccessNoticeIcon" aria-hidden="true">
                ✓
              </span>
              <span>{actionSuccess}</span>
            </div>
          ) : null}

          {activeSection === "scan" ? (
            <section className="appSection appSection--scan">
              <div className="scanStage">
                <div className="scanStageMain">
                  <div className="scanHero">
                    <h1>Check account health.</h1>
                    <p>Scan a Stellar address to see what needs attention before you clean up or merge the account.</p>
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
                      <div className="scanHelperCard">
                        <span className="scanHelperIcon" aria-hidden="true" />
                        <p>No signing is required to scan. Use your wallet only when you approve a cleanup or merge action.</p>
                      </div>
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
                </div>

                <section className="scanSavedSection" aria-label="Saved accounts">
                  <div className="scanSavedSectionLabel">Saved accounts</div>
                  <div className="savedAccountList">
                    {scanSavedAccounts.map((entry, index) => (
                      <button
                        key={`${entry.title}-${entry.accountId}-${index}`}
                        type="button"
                        className="savedAccountCard"
                        onClick={() => setSource(entry.accountId)}
                      >
                        <span className={`savedAccountDot savedAccountDot--${entry.tone}`} />
                        <div className="savedAccountCopy">
                          <strong>{entry.title}</strong>
                          <span>{entry.accountId}</span>
                        </div>
                        <div className="savedAccountMeta">
                          {entry.networkLabel ? <span className="savedAccountPill">{entry.networkLabel}</span> : null}
                          <small>{entry.timeLabel}</small>
                          <span>{entry.status}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>

                <div className="scanStageStats">
                  <LiveStatsPanel stats={liveStats} compact className="liveStatsCard--sidebar liveStatsCard--scanFallback" />
                </div>
              </div>
            </section>
          ) : null}

          {activeSection === "review" ? (
            <section className="appSection appSection--review">
              <div className="reviewShell">
                <div className="reviewHeader">
                  <div className="reviewHeaderCopy">
                    <SectionKicker>Review</SectionKicker>
                    <h1>Account Health</h1>
                    <div className="reviewHeaderMeta">
                      <span className="reviewAccountId">{sourceLabel}</span>
                      <span className="reviewNetworkPill">{networkLabel}</span>
                    </div>
                  </div>
                  <div className="reviewHeaderActions">
                    <button
                      type="button"
                      className="btn secondary reviewHeaderSave"
                      onClick={() => saveAccountToWatchlist(sourceTrim, network, health)}
                      disabled={!sourceTrim || !health}
                    >
                      {isSaved ? "Saved address" : "Save address"}
                    </button>
                    <button type="button" className="btn primary reviewHeaderCta" onClick={() => setActiveSection("clean")}>
                      Cleanup plan
                    </button>
                  </div>
                </div>

                <div className="reviewStatsGrid">
                  {reviewStats.map((stat) => (
                    <article key={stat.label} className={`reviewStatCard reviewStatCard--${stat.tone}`}>
                      <span>{stat.label}</span>
                      <strong>{stat.value}</strong>
                    </article>
                  ))}
                </div>

                <div className="reviewNotice">
                  <span className="reviewNoticeIcon" aria-hidden="true">
                    ✓
                  </span>
                  <span>Read-only scan complete. No wallet approval has been requested.</span>
                </div>

                <div className="reviewTabs" role="tablist" aria-label="Review categories">
                  {reviewTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={reviewTab === tab.id}
                      className={`reviewTab${reviewTab === tab.id ? " reviewTab--active" : ""}`}
                      onClick={() => setReviewTab(tab.id)}
                    >
                      <span>{tab.label}</span>
                      <strong>{tab.count}</strong>
                    </button>
                  ))}
                </div>

                <p className="reviewTabHint">{reviewTabs.find((tab) => tab.id === reviewTab)?.hint}</p>

                <div className="reviewPanelGrid">
                  {reviewTabContent[reviewTab].length > 0 ? (
                    reviewTabContent[reviewTab].map((card) => (
                      <article key={card.title} className={`reviewDetailCard reviewDetailCard--${card.tone}`}>
                        <div className="reviewDetailTop">
                          <div>
                            <h2>{card.title}</h2>
                            <p>{card.detail}</p>
                          </div>
                          {card.actionTarget ? (
                            <button
                              type="button"
                              className={`statusBadge reviewActionBadge reviewActionBadge--${card.tone}`}
                              onClick={() => openWorkflowTarget(card.actionTarget)}
                              aria-label={card.actionLabel}
                            >
                              {card.actionLabel}
                            </button>
                          ) : (
                            <span className="statusBadge reviewActionBadge reviewActionBadge--neutral" aria-label={card.actionLabel}>
                              {card.actionLabel}
                            </span>
                          )}
                        </div>
                        <p className="reviewDetailBody">{card.body}</p>
                        <div className="reviewDetailMeta">
                          <span className={`reviewMeta reviewMeta--${card.metaLeftTone}`}>{card.metaLeft}</span>
                          <span className={`reviewMeta reviewMeta--${card.metaRightTone}`}>{card.metaRight}</span>
                        </div>
                      </article>
                    ))
                  ) : (
                    <div className="reviewEmptyState">No active items in this section.</div>
                  )}
                </div>
              </div>
            </section>
          ) : null}

          {activeSection === "clean" ? (
            <section className="appSection appSection--clean">
              <div className="cleanupShell">
                <div className="cleanupHeader">
                  <div className="cleanupHeaderCopy">
                    <SectionKicker>Clean</SectionKicker>
                    <h1>{sourceTrim ? "Cleanup plan" : "Select an account to clean."}</h1>
                    <p>{sourceTrim ? "6 steps · dependency-aware order · account refreshes after each action" : "Scan an account or open one from Review before building the cleanup plan."}</p>
                  </div>
                  <button type="button" className="btn primary cleanupHeaderCta" onClick={() => setActiveSection("merge")}>
                    Merge / Payout
                  </button>
                </div>

                <div className="cleanupProgress">
                  <div className="cleanupProgressTrack">
                    <span />
                  </div>
                  <span>0 / 6 done</span>
                </div>

                <div className="cleanupStepStack">
                  {cleanupSteps
                    .filter((step) => step.visible)
                    .map((step) => (
                    <article
                      key={step.id}
                      ref={(node) => {
                        cleanupStepRefs.current[step.id] = node;
                      }}
                      className={`cleanupStepCard cleanupStepCard--${step.state.toLowerCase().replaceAll(" ", "-")}${cleanupFocusStep === step.id ? " cleanupStepCard--focused" : ""}`}
                    >
                      <div className="cleanupStepHeader">
                        <div className="cleanupStepIdentity">
                          <span className="cleanupStepNumber">{step.num}</span>
                          <div>
                            <h2>{step.title}</h2>
                            <p>{step.detail}</p>
                          </div>
                        </div>
                        <span className={`statusBadge ${step.state === "Ready" ? "statusBadge--ok" : step.state === "Manual review" ? "statusBadge--warn" : ""}`}>{step.state}</span>
                      </div>
                      <div className="cleanupStepBody">
                        <p className="cleanupStepWhy">
                          <span>Why now:</span> {step.why}
                        </p>
                        <p className="cleanupStepResult">
                          <span>Expected result:</span> {step.result}
                        </p>
                      </div>
                      <div className="cleanupStepFooter">
                        <div className="cleanupStepMeta">
                          <strong>{step.benefit}</strong>
                          <span>{step.actionMode === "disabled" ? "No wallet action" : "Wallet required"}</span>
                          <span>{step.actionMode === "tx" ? "Reversible" : step.actionMode === "planner" ? "Planner" : "Manual review"}</span>
                        </div>
                        {step.actionMode !== "disabled" ? (
                          <button
                            type="button"
                            className={`btn ${step.actionMode === "manual" ? "secondary" : "primary"} cleanupStepAction`}
                            onClick={() => {
                              if (step.actionMode === "tx") {
                                setCleanupReviewStep(step.id);
                                return;
                              }
                              step.onClick?.();
                            }}
                          >
                            {step.actionLabel}
                          </button>
                        ) : (
                          <span className="cleanupStepBlocked">Blocked by: {step.blockedBy}</span>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {cleanupTrustlinePlannerOpen && showTrustlineTeardown && health?.horizonUrl ? (
            <div className="modalOverlay" role="presentation" onClick={() => setCleanupTrustlinePlannerOpen(false)}>
              <section
                className="cleanupPlannerModal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="cleanup-planner-modal-title"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="cleanupReviewModalHeader">
                  <div>
                    <span className="modalKicker">Trustline planner</span>
                    <h2 id="cleanup-planner-modal-title">Route asset balances</h2>
                  </div>
                  <button type="button" className="modalCloseButton" aria-label="Close trustline planner" onClick={() => setCleanupTrustlinePlannerOpen(false)}>
                    ×
                  </button>
                </div>

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
                  onRecoveredEvent={(event) => void liveStats.recordEvent(event)}
                  offersBlocked={checklistById.get("classic_open_offers")?.status === "fail"}
                  onSummaryChange={setTrustlineSummary}
                  onSubmitted={refreshHealth}
                />
              </section>
            </div>
          ) : null}

          {cleanupReviewStepData && cleanupReviewStepData.actionMode === "tx" ? (
            <div className="modalOverlay" role="presentation" onClick={() => setCleanupReviewStep(null)}>
              <section
                className="cleanupReviewModal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="cleanup-review-modal-title"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="cleanupReviewModalHeader">
                  <div>
                    <span className="modalKicker">Transaction review</span>
                    <h2 id="cleanup-review-modal-title">{cleanupReviewStepData.title}</h2>
                  </div>
                  <button type="button" className="modalCloseButton" aria-label="Close review" onClick={() => setCleanupReviewStep(null)}>
                    ×
                  </button>
                </div>

                <div className="cleanupReviewModalGrid">
                  <div className="cleanupReviewModalRow">
                    <span>Account</span>
                    <strong>{sourceTrim ? formatAccount(sourceTrim) : "Select an account"}</strong>
                  </div>
                  <div className="cleanupReviewModalRow">
                    <span>Operations</span>
                    <strong>1 operation</strong>
                  </div>
                  <div className="cleanupReviewModalRow">
                    <span>Current state</span>
                    <strong>{cleanupReviewStepData.detail}</strong>
                  </div>
                  <div className="cleanupReviewModalRow">
                    <span>Expected result</span>
                    <strong>{cleanupReviewStepData.result}</strong>
                  </div>
                  <div className="cleanupReviewModalRow">
                    <span>XLM impact</span>
                    <strong>{cleanupReviewStepData.benefit}</strong>
                  </div>
                  <div className="cleanupReviewModalRow">
                    <span>Network fee</span>
                    <strong>0.00001 XLM</strong>
                  </div>
                  <div className="cleanupReviewModalRow">
                    <span>Risk</span>
                    <strong>Reversible</strong>
                  </div>
                </div>

                <div className="cleanupReviewModalNote">
                  Review the operation before wallet approval. Orbitway will refresh the snapshot after the transaction is
                  submitted.
                </div>

                <div className="cleanupReviewModalActions">
                  <button type="button" className="btn ghost" onClick={() => setCleanupReviewStep(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={walletBusy}
                    onClick={() => {
                      const target = cleanupReviewStepData;
                      if (!target) return;
                      setCleanupReviewStep(null);
                      if (!walletAddress) {
                        void connectWallet();
                        return;
                      }
                      target.onClick?.();
                    }}
                  >
                    Approve in wallet
                  </button>
                </div>
              </section>
            </div>
          ) : null}

          {activeSection === "merge" ? (
            <section className="appSection appSection--merge">
              <div className="mergeShell">
                <div className="mergeHeader">
                  <div className="mergeHeaderCopy">
                    <SectionKicker>Merge</SectionKicker>
                    <h1>{sourceTrim ? "Merge / Payout" : "Select an account to merge."}</h1>
                    <p>{sourceTrim ? "Final merge permanently removes the source account. Complete all cleanup steps first." : "Scan an account or choose one from Review before starting the final merge flow."}</p>
                  </div>
                </div>

                <div className="mergeWarning">
                  <div className="mergeWarningIcon" aria-hidden="true">
                    !
                  </div>
                  <div>
                    <strong>Irreversible action</strong>
                    <p>
                      <code>ACCOUNT_MERGE</code> permanently removes the source account. Only continue after reviewing the destination and all remaining blockers.
                    </p>
                  </div>
                </div>

                <h2 className="mergeSectionTitle">Merge readiness checklist</h2>
                <div className="mergeChecklist">
                  {mergeChecklist.map((row) => (
                    <div key={row.label} className={`mergeChecklistRow mergeChecklistRow--${row.tone}`}>
                      <span className="mergeChecklistIcon" aria-hidden="true">
                        {row.tone === "ok" ? "✓" : "×"}
                      </span>
                      <span className="mergeChecklistLabel">{row.label}</span>
                      <div className="mergeChecklistStatusArea">
                        <span className="mergeChecklistStatus">{row.right}</span>
                        {"actionLabel" in row && row.actionLabel ? (
                          <button
                            type="button"
                            className={`btn ${row.tone === "ok" ? "secondary" : "ghost"} mergeChecklistAction`}
                            disabled={row.label === "Destination reviewed" && !destOk}
                            onClick={() => row.onClick?.()}
                          >
                            {row.actionLabel}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mergeDestination">
                  <h2>Destination</h2>
                  <div className="segmented mergeSegmented" role="tablist" aria-label="Destination type">
                    {[
                      { id: "wallet" as const, label: "Wallet" },
                      { id: "exchange" as const, label: "Exchange" },
                      { id: "unsure" as const, label: "Not Sure" },
                    ].map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`seg${mergeDestinationMode === option.id ? " active" : ""}`}
                        onClick={() => setMergeDestinationMode(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>

                  <label className="label" htmlFor="dest">
                    Destination Stellar address
                  </label>
                  <input
                    id="dest"
                    className="input"
                    placeholder="G..."
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    spellCheck={false}
                    autoCapitalize="none"
                  />

                  <div className={`mergeCallout mergeCallout--${mergeDestinationMode}`}>
                    <span className="mergeCalloutIcon" aria-hidden="true">
                      i
                    </span>
                  </div>
                  <p className="mergeHelper">
                    Ensure this destination supports direct <code>ACCOUNT_MERGE</code>, or select the exchange flow above to use a mediator account.
                  </p>

                  <div className="mergeSummaryCard">
                    <span>Merge summary</span>
                    <div className="mergeSummaryRows">
                      {mergeSummaryRows.map(([label, value]) => (
                        <div key={label} className="mergeSummaryRow">
                          <span>{label}</span>
                          <strong>{value}</strong>
                        </div>
                      ))}
                    </div>
                  </div>

                  <button type="button" className="btn primary mergeReviewButton" disabled={!mergeCanProceed || !health?.horizonUrl || mergeBusy} onClick={() => void runAccountMerge()}>
                    Review final merge
                  </button>
                  <p className="mergeFooterHint">Complete cleanup, set a valid destination, and acknowledge the irreversible step before merging.</p>
                </div>
              </div>
            </section>
          ) : null}
        </section>
      </main>
      {destinationModalOpen ? (
        <div
          className="destinationModalOverlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDestinationModalOpen(false);
          }}
        >
          <section className="destinationModal" role="dialog" aria-modal="true" aria-labelledby="destination-modal-title">
            <div>
              <span className="modalKicker">Merge safely</span>
              <h2 id="destination-modal-title">Save destination address</h2>
              <p>
                This is where native XLM will be sent if you later approve the final account merge. You can edit it before
                signing.
              </p>
            </div>
            <label className="label" htmlFor="destination-modal-input">
              Destination Stellar address
            </label>
            <input
              id="destination-modal-input"
              className="input"
              placeholder="G..."
              value={destinationDraft}
              onChange={(event) => setDestinationDraft(event.target.value)}
              spellCheck={false}
              autoCapitalize="none"
              autoFocus
            />
            {destinationDraft.trim() && !isValidClassicAddress(destinationDraft.trim()) ? (
              <p className="error">Enter a valid classic G-address.</p>
            ) : null}
            {destOk && destination.trim() ? (
              <p className="destinationModalSaved">Current saved destination: {formatAccount(destination.trim())}</p>
            ) : null}
            <div className="destinationModalActions">
              <button type="button" className="btn secondary" onClick={() => setDestinationModalOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!isValidClassicAddress(destinationDraft.trim())}
                onClick={saveDestinationFromModal}
              >
                Save destination
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const route = useRouteMode();
  const liveStats = useLiveStats();
  return <AppErrorBoundary>{route === "app" ? <AppShell liveStats={liveStats} /> : <LandingPage liveStats={liveStats} />}</AppErrorBoundary>;
}
