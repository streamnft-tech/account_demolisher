import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Blocker, BlockerCode, ChecklistStatus, HealthChecklistItem, HealthReport, SponsoredLedgerEntry } from "@stellar/core";
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
import { buildRevokeSponsorshipEntryXdr } from "./sponsorshipRevoke.js";
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

const scanChecklistLabels = [
  "Estimated reserve release",
  "Trustline cleanup",
  "Account states",
  "Open offers and DeFi tools",
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

function AccountHealthPreview() {
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
    </aside>
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
          <AccountHealthPreview />
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

function scanRowCopy(
  label: string,
  row: HealthChecklistItem | undefined,
  health: HealthReport,
  context?: { reserveReleaseLabel?: string; destination?: string; destOk?: boolean },
) {
  if (label === "Estimated reserve") {
    return row?.status === "pass"
      ? { value: "0 XLM locked value", detail: "No removable trustlines were returned by the latest scan.", tone: "pass" }
      : {
          value: context?.reserveReleaseLabel ? `${context.reserveReleaseLabel} locked value` : "Locked value not estimated",
          detail: "Token lines still hold reserve. Review each trustline below to release it safely.",
          tone: "fail",
        };
  }
  if (label === "Claimable balances") {
    return row?.status === "pass"
      ? { value: "None", detail: "No claimable balances were returned by the latest scan.", tone: "pass" }
      : { value: "Available", detail: "These balances are claimable to the account and are separate from reserve release.", tone: "fail" };
  }
  if (label === "Trustlines") {
    return row?.status === "pass"
      ? { value: "Clear", detail: "No removable trustlines were detected.", tone: "pass" }
      : { value: "Needs cleanup", detail: "Trustlines must be resolved before the account can close cleanly.", tone: "fail" };
  }
  if (label === "Sponsorships") {
    const count = health.classicAccount?.sponsorships.sponsoringCount ?? 0;
    const entryCount = health.classicAccount?.sponsorships.entries?.length ?? 0;
    const estimatedReserveXlm = count * BASE_RESERVE_XLM;
    return row?.status === "pass"
      ? { value: "None", detail: "No sponsorship relationships are blocking the account.", tone: "pass" }
      : {
          value: count > 0 ? `~${formatEstimatedXlm(estimatedReserveXlm)} reserved` : "Sponsored reserve",
          detail:
            entryCount > 0
              ? `${entryCount} sponsored ${entryCount === 1 ? "entry" : "entries"} found. This account is paying reserve for sponsored ledger entries.`
              : "This account is paying reserve for sponsored ledger entries.",
          tone: "fail",
        };
  }
  if (label === "Open offers") {
    return row?.status === "pass"
      ? { value: "Clear", detail: "No outstanding SDEX orders were returned by the latest scan.", tone: "pass" }
      : { value: "Needs cleanup", detail: "Outstanding SDEX orders can block a clean account close.", tone: "fail" };
  }
  if (label === "Liquidity positions") {
    return row?.status === "pass"
      ? { value: "Clear", detail: "No AMM or liquidity-pool share balances were returned.", tone: "pass" }
      : { value: "Needs cleanup", detail: "Liquidity-pool share balances may need withdrawal before close.", tone: "fail" };
  }
  if (label === "Allowances") {
    return {
      value: "Coming soon",
      detail: "Allowance discovery is planned, but revoke actions are not integrated yet.",
      tone: "unknown",
    };
  }
  if (label === "Account control") {
    return row?.status === "pass"
      ? { value: "Single control", detail: "No additional signers were detected.", tone: "pass" }
      : { value: "Shared control", detail: "Signer keys and approval weights should be reviewed before write actions.", tone: "fail" };
  }
  if (label === "Thresholds / approval rules") {
    return row?.status === "pass"
      ? { value: "Default", detail: "Approval rules are at the expected defaults.", tone: "pass" }
      : { value: "Review rules", detail: "Custom approval rules should be checked before cleanup or close.", tone: "fail" };
  }
  if (label === "Destination") {
    const destination = context?.destination?.trim() ?? "";
    if (destination && context?.destOk) {
      return {
        value: "Saved",
        detail: `Destination saved: ${formatAccount(destination)}.`,
        tone: "pass",
      };
    }
    return {
      value: "Not set",
      detail: "Save a destination before triggering the final close flow.",
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

function formatEstimatedXlm(value: number): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: value < 10 ? 1 : 0,
    maximumFractionDigits: 2,
  }).format(value) + " XLM";
}

function rowActionFor(
  row: HealthChecklistItem | undefined,
  opts: {
    walletConnected: boolean;
    onConnectWallet: () => void;
    onCloseStep: () => void;
    onTrustlinePlanner: () => void;
    onResolveClassicBlocker: (code: BlockerCode) => void;
    walletBusy: boolean;
    pendingClassicAction: BlockerCode | null;
  },
): { label: string; disabled?: boolean; onClick?: () => void } {
  if (!row) return { label: "Unsupported", disabled: true };
  if (row.status === "pass") return { label: "No action needed", disabled: true };
  if (row.id === "native_merge_payout") return { label: "Review close flow", onClick: opts.onCloseStep };
  if (row.id === "classic_min_reserve") return { label: "Set destination", onClick: opts.onCloseStep };
  if (row.id === "defi_positions") return { label: "Review manually" };
  if (row.id === "soroban_allowances") {
    return { label: "Coming soon", disabled: true };
  }
  const blockerActions: Partial<Record<string, { code: BlockerCode; label: string }>> = {
    classic_open_offers: { code: "OPEN_OFFERS", label: "Cancel open offers" },
    classic_claimable_balances: { code: "CLAIMABLE_BALANCES_PENDING", label: "Claim balance" },
    classic_sponsorship: { code: "SPONSORING_OTHER_ACCOUNTS", label: "Revoke sponsored reserves" },
    classic_data_entries: { code: "DATA_ENTRIES", label: "Remove data entries" },
    classic_extra_signers: { code: "MULTISIG_OR_EXTRA_SIGNERS", label: "Remove extra signers" },
    classic_thresholds: { code: "NON_DEFAULT_THRESHOLDS", label: "Set merge-friendly rules" },
    classic_amm_lp_shares: { code: "OPEN_LIQUIDITY_POOL", label: "Close position" },
  };
  if (row.id === "classic_trustlines") {
    return { label: "Open token planner", onClick: opts.onTrustlinePlanner };
  }
  const action = blockerActions[row.id];
  if (action) {
    if (!opts.walletConnected) return { label: "Connect Wallet", onClick: opts.onConnectWallet };
    if (opts.pendingClassicAction === action.code) {
      return {
        label: action.code === "SPONSORING_OTHER_ACCOUNTS" ? "Preparing wallet approval..." : "Preparing...",
        disabled: true,
      };
    }
    return {
      label: action.label,
      disabled: opts.walletBusy,
      onClick: () => opts.onResolveClassicBlocker(action.code),
    };
  }
  if (row.status === "unknown" || row.status === "skipped") return { label: "Review manually" };
  return { label: "Unsupported", disabled: true };
}

function formatLongKey(key: string): string {
  if (key.length <= 18) return key;
  return `${key.slice(0, 8)}...${key.slice(-6)}`;
}

function sponsorshipEntryKey(entry: SponsoredLedgerEntry): string {
  return `${entry.type}:${entry.id}:${entry.accountId ?? ""}`;
}

function sponsorshipEntryAddress(entry: SponsoredLedgerEntry): string {
  return entry.accountId ?? entry.id;
}

function canRevokeSponsoredEntry(entry: SponsoredLedgerEntry): boolean {
  return entry.type !== "trustline";
}

function sponsorshipEntryTypeLabel(type: SponsoredLedgerEntry["type"]): string {
  return type.replaceAll("_", " ");
}

function SponsorshipRowDetails({
  health,
  pending,
  pendingEntryKey,
  walletConnected,
  walletBusy,
  onConnectWallet,
  onRevokeEntry,
  showIntro = true,
  showTechnical = true,
}: {
  health: HealthReport;
  pending: boolean;
  pendingEntryKey: string | null;
  walletConnected: boolean;
  walletBusy: boolean;
  onConnectWallet: () => void;
  onRevokeEntry: (entry: SponsoredLedgerEntry) => void;
  showIntro?: boolean;
  showTechnical?: boolean;
}) {
  const sponsorshipRow = health.checklist.find((row) => row.id === "classic_sponsorship");
  const rowCountMatch = sponsorshipRow?.detail?.match(/(\d+)/);
  const fallbackCount = rowCountMatch ? Number(rowCountMatch[1]) : 0;
  const count = health.classicAccount?.sponsorships.sponsoringCount ?? fallbackCount;
  const entries = health.classicAccount?.sponsorships.entries ?? [];
  const visibleEntries = entries.slice(0, 12);
  const estimatedReserveXlm = count * BASE_RESERVE_XLM;
  return (
    <div className="scanInsightBlock">
      {showIntro ? (
        <p>
          This account is paying about {count > 0 ? formatEstimatedXlm(estimatedReserveXlm) : "an unknown amount of XLM"} of
          reserve{entries.length > 0 ? ` for ${entries.length} sponsored entr${entries.length === 1 ? "y" : "ies"}` : ""}.
          Revoke sponsorship before closing.
        </p>
      ) : null}
      {entries.length > 0 ? (
        <div className="sponsorshipEntryList">
          <div className="sponsorshipEntryListHeader">
            <strong>
              Sponsored entries found: {entries.length}
            </strong>
            <span>~{formatEstimatedXlm(estimatedReserveXlm)} estimated reserve</span>
          </div>
          {visibleEntries.map((entry) => {
            const key = sponsorshipEntryKey(entry);
            const entryPending = pendingEntryKey === key;
            const supported = canRevokeSponsoredEntry(entry);
            const entryReserveXlm = entries.length > 0 ? estimatedReserveXlm / entries.length : estimatedReserveXlm;
            return (
            <article key={key} className="sponsorshipEntry resultActionRow resultActionRow--state">
              <span className="stateValue stateValue--fail">{sponsorshipEntryTypeLabel(entry.type)}</span>
              <div className="sponsorshipEntryMain">
                <strong className="monoDetail">{formatLongKey(sponsorshipEntryAddress(entry))}</strong>
                <p>{entry.detail && entry.detail !== formatLongKey(sponsorshipEntryAddress(entry)) ? entry.detail : "Sponsored ledger entry"}</p>
              </div>
              <div className="sponsorshipEntryReserve">
                <span>Estimated reserve</span>
                <strong>~{formatEstimatedXlm(entryReserveXlm)}</strong>
              </div>
              <button
                type="button"
                className={supported && walletConnected ? "btn secondary sponsorshipEntryAction" : "btn ghost sponsorshipEntryAction"}
                disabled={walletBusy || !supported}
                title={supported ? "Revoke this sponsored entry" : "Use batch revoke for this sponsored entry type"}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!walletConnected) {
                    onConnectWallet();
                    return;
                  }
                  onRevokeEntry(entry);
                }}
              >
                {entryPending ? "Preparing..." : walletConnected ? "Revoke" : "Connect"}
              </button>
            </article>
            );
          })}
          {entries.length > visibleEntries.length ? (
            <p className="meta">Showing first {visibleEntries.length}; revoke action will prepare the next supported batch.</p>
          ) : null}
        </div>
      ) : count > 0 ? (
        <p className="actionProgressNote">
          Orbitway found the sponsorship count, but Horizon did not return entry details in this scan. The revoke action will
          still discover supported entries before wallet approval.
        </p>
      ) : null}
      {pending ? (
        <p className="actionProgressNote">
          Orbitway is finding sponsored ledger entries. Your wallet approval will appear after the transaction is prepared.
        </p>
      ) : showTechnical ? (
        <p className="meta">
          Technical: Horizon reports num_sponsoring = {count || "unknown"} reserve unit{count === 1 ? "" : "s"}. Base reserve is
          estimated at {BASE_RESERVE_XLM} XLM, so this is about{" "}
          {count > 0 ? formatEstimatedXlm(estimatedReserveXlm) : "an unknown XLM amount"}. If more sponsored entries remain
          after revoke, Orbitway will ask you to run the action again after confirmation.
        </p>
      ) : null}
    </div>
  );
}

function PermissionRowDetails({
  health,
  row,
  action,
}: {
  health: HealthReport;
  row: HealthChecklistItem | undefined;
  action?: { label: string; disabled?: boolean; onClick?: () => void };
}) {
  const account = health.classicAccount;
  if (!account) return <p>{row?.detail ?? "Permission details were not returned by this scan."}</p>;
  const isExtraSignerRow = row?.id === "classic_extra_signers";
  const isThresholdRow = row?.id === "classic_thresholds";
  if (!isExtraSignerRow && !isThresholdRow) return <p>{row?.detail ?? "Review this permission state before write actions."}</p>;
  const detailActionLabel =
    action?.label === "Connect Wallet" || action?.label.includes("Preparing")
      ? action.label
      : isExtraSignerRow
        ? "Remove signer"
        : "Set rules";

  if (isExtraSignerRow) {
    return (
      <div className="scanInsightBlock permissionDetailBlock">
        <p>
          These are keys allowed to approve actions for this account. This scan shows who can control this account; it does
          not prove where this account is a signer on someone else's multisig.
        </p>
        <div className="permissionEntryList">
          <div className="permissionEntryListHeader">
            <strong>
              Extra signers found: {account.signers.extra.length}
            </strong>
            <span>master key weight {account.signers.masterWeight}</span>
          </div>
          {account.signers.extra.length > 0 ? (
            account.signers.extra.map((signer) => (
              <article key={signer.key} className="permissionEntry resultActionRow resultActionRow--state">
                <div className="permissionEntryMain">
                  <strong className="monoDetail">{formatLongKey(signer.key)}</strong>
                  <p>Additional signer allowed to approve account actions.</p>
                </div>
                <div className="permissionEntryMetric">
                  <span>Weight</span>
                  <strong>{signer.weight}</strong>
                </div>
                <div className="permissionEntryMetric">
                  <span>Cleanup effect</span>
                  <strong>Remove signer</strong>
                </div>
                <button
                  type="button"
                  className={action?.disabled ? "btn ghost permissionEntryAction" : "btn secondary permissionEntryAction"}
                  disabled={action?.disabled}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    action?.onClick?.();
                  }}
                >
                  {detailActionLabel}
                </button>
              </article>
            ))
          ) : (
            <article className="permissionEntry resultActionRow resultActionRow--state">
              <div className="permissionEntryMain">
                <strong>Single account control</strong>
                <p>No additional signer keys were returned by the latest scan.</p>
              </div>
              <span className="stateValue stateValue--pass">Clear</span>
            </article>
          )}
        </div>
      </div>
    );
  }

  const thresholdRows = [
    ["Low threshold", account.thresholds.low, "Low-risk account actions"],
    ["Medium threshold", account.thresholds.medium, "Most cleanup and account update actions"],
    ["High threshold", account.thresholds.high, "High-impact account actions"],
    ["Master key weight", account.signers.masterWeight, "Native authority for this account"],
  ] as const;

  return (
    <div className="scanInsightBlock permissionDetailBlock">
      <p>
        These approval rules decide how much signer weight is needed for account actions. Merge-friendly rules make cleanup
        and final close easier to complete.
      </p>
      <div className="permissionEntryList">
        <div className="permissionEntryListHeader">
          <strong>Approval rules</strong>
          <span>{account.thresholds.mergeFriendly ? "merge-friendly" : "needs cleanup"}</span>
        </div>
        {thresholdRows.map(([label, value, detail]) => (
          <article key={label} className="permissionEntry resultActionRow resultActionRow--state">
            <div className="permissionEntryMain">
              <strong>{label}</strong>
              <p>{detail}</p>
            </div>
            <div className="permissionEntryMetric">
              <span>Current value</span>
              <strong>{value}</strong>
            </div>
            <div className="permissionEntryMetric">
              <span>Target state</span>
              <strong>{label === "Master key weight" ? "1" : "Merge-friendly"}</strong>
            </div>
            {account.thresholds.mergeFriendly ? (
              <span className="stateValue stateValue--pass">Clear</span>
            ) : (
              <button
                type="button"
                className={action?.disabled ? "btn ghost permissionEntryAction" : "btn secondary permissionEntryAction"}
                disabled={action?.disabled}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  action?.onClick?.();
                }}
              >
                {detailActionLabel}
              </button>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

function ProtocolReviewRows({ health }: { health: HealthReport }) {
  const protocols = health.openPositions?.defiProtocols ?? [];
  if (protocols.length === 0) return null;
  return (
    <div className="protocolReviewStack">
      <h4>DeFi-specific tools</h4>
      {protocols.map((protocol) => (
        <article key={protocol.id} className="protocolRow">
          <div>
            <strong>{protocol.label}</strong>
            <p>{protocol.detail}</p>
          </div>
          <span className="stateValue stateValue--unknown">Coming soon</span>
        </article>
      ))}
    </div>
  );
}

function AccountStateDetails({
  health,
  checklist,
  walletConnected,
  walletBusy,
  onConnectWallet,
  onCloseStep,
  onSetDestination,
  onTrustlinePlanner,
  onResolveClassicBlocker,
  onRevokeSponsoredEntry,
  pendingClassicAction,
  pendingSponsoredEntryKey,
  trustlinePanel,
  destination,
  destOk,
  reserveReleaseLabel,
  embedded = false,
}: {
  health: HealthReport;
  checklist: HealthChecklistItem[];
  walletConnected: boolean;
  walletBusy: boolean;
  onConnectWallet: () => void;
  onCloseStep: () => void;
  onSetDestination: () => void;
  onTrustlinePlanner: () => void;
  onResolveClassicBlocker: (code: BlockerCode) => void;
  onRevokeSponsoredEntry: (entry: SponsoredLedgerEntry) => void;
  pendingClassicAction: BlockerCode | null;
  pendingSponsoredEntryKey: string | null;
  trustlinePanel?: ReactNode;
  destination: string;
  destOk: boolean;
  reserveReleaseLabel: string;
  embedded?: boolean;
}) {
  const byId = new Map(checklist.map((row) => [row.id, row]));
  const protocolRowsCount = health.openPositions?.defiProtocols.length ?? 0;
  const groups = [
    {
      id: "unlock-value",
      title: "Unlock value",
      description: "Estimated reserve release and claimable balances are separated from account-state blockers.",
      rows: [
        ["Estimated reserve", byId.get("classic_trustlines")],
        ["Claimable balances", byId.get("classic_claimable_balances")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      id: "account-states",
      title: "Account states",
      description: "Review sponsorships, approvals, shared control, and account rules that affect cleanup.",
      rows: [
        ["Sponsorships", byId.get("classic_sponsorship")],
        ["Allowances", byId.get("soroban_allowances")],
        ["Account control", byId.get("classic_extra_signers")],
        ["Thresholds / approval rules", byId.get("classic_thresholds")],
        ["Data entries", byId.get("classic_data_entries")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      id: "open-positions",
      title: "Open offers & DeFi tools",
      description: "Review market orders, liquidity positions, and protocol-specific exits in one place.",
      rows: [
        ["Open offers", byId.get("classic_open_offers")],
        ["Liquidity positions", byId.get("classic_amm_lp_shares")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
    {
      id: "close-safely",
      title: "Close safely",
      description: "Confirm destination, manual review, and final readiness before the irreversible step.",
      rows: [
        ["Destination", undefined],
        ["Close readiness", byId.get("classic_min_reserve")],
      ] as Array<[string, HealthChecklistItem | undefined]>,
    },
  ];

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
                  {group.rows.length + (group.id === "open-positions" ? protocolRowsCount : 0)} item
                  {group.rows.length + (group.id === "open-positions" ? protocolRowsCount : 0) === 1 ? "" : "s"}
                </span>
                <span className="stateDetailGroupChevron" aria-hidden>
                  ⌄
                </span>
              </span>
            </summary>
            <div className="stateDetailRows">
              {group.rows.map(([label, row]) => {
                const copy = scanRowCopy(label, row, health, { reserveReleaseLabel, destination, destOk });
                if (label === "Estimated reserve") {
                  return (
                    <article key={label} className={`scanReportRow scanReportRow--${group.id} scanReportRow--reserve`}>
                      <div className="scanReportReserveHeader">
                        <div className="scanReportMain">
                          <span>{label}</span>
                          <p>{copy.detail}</p>
                        </div>
                        <strong className={`stateValue stateValue--${copy.tone}`}>{copy.value}</strong>
                      </div>
                      {trustlinePanel ? (
                        <div className="scanReportEmbeddedPanel scanReportEmbeddedPanel--inline">{trustlinePanel}</div>
                      ) : (
                        <p className="scanReportInlineNote">{row?.detail ?? copy.detail}</p>
                      )}
                    </article>
                  );
                }
                if (label === "Sponsorships" && row?.status !== "pass") {
                  return (
                    <article key={label} className={`scanReportRow scanReportRow--${group.id} scanReportRow--sponsorships`}>
                      <div className="scanReportReserveHeader scanReportReserveHeader--sponsorships">
                        <div className="scanReportMain">
                          <span>{label}</span>
                          <p>{copy.detail}</p>
                        </div>
                        <strong className={`stateValue stateValue--${copy.tone}`}>{copy.value}</strong>
                      </div>
                      <div className="scanReportEmbeddedPanel scanReportEmbeddedPanel--inline">
                        <SponsorshipRowDetails
                          health={health}
                          pending={pendingClassicAction === "SPONSORING_OTHER_ACCOUNTS"}
                          pendingEntryKey={pendingSponsoredEntryKey}
                          walletConnected={walletConnected}
                          walletBusy={walletBusy}
                          onConnectWallet={onConnectWallet}
                          onRevokeEntry={onRevokeSponsoredEntry}
                          showIntro={false}
                          showTechnical={false}
                        />
                      </div>
                    </article>
                  );
                }
                if (row?.id === "classic_extra_signers" || row?.id === "classic_thresholds") {
                  const action = rowActionFor(row, {
                    walletConnected,
                    walletBusy,
                    onConnectWallet,
                    onCloseStep,
                    onTrustlinePlanner,
                    onResolveClassicBlocker,
                    pendingClassicAction,
                  });
                  return (
                    <article key={label} className={`scanReportRow scanReportRow--${group.id} scanReportRow--permissions`}>
                      <div className="scanReportReserveHeader scanReportReserveHeader--permissions">
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
                      </div>
                      <div className="scanReportEmbeddedPanel scanReportEmbeddedPanel--inline">
                        <PermissionRowDetails health={health} row={row} action={action} />
                      </div>
                    </article>
                  );
                }
                const action =
                  label === "Destination"
                    ? { label: destOk ? "Edit destination" : "Save destination", onClick: onSetDestination }
                    : label === "Close readiness"
                        ? walletConnected
                          ? { label: "Open close flow", onClick: onCloseStep }
                          : { label: "Connect Wallet", onClick: onConnectWallet }
                        : rowActionFor(row, {
                            walletConnected,
                            walletBusy,
                            onConnectWallet,
                            onCloseStep,
                            onTrustlinePlanner,
                            onResolveClassicBlocker,
                            pendingClassicAction,
                          });
                return (
                  <details key={label} className={`scanReportRow scanReportRow--${group.id}`}>
                    <summary className="resultActionRow">
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
                      {row?.id === "classic_sponsorship" ? (
                        <SponsorshipRowDetails
                          health={health}
                          pending={pendingClassicAction === "SPONSORING_OTHER_ACCOUNTS"}
                          pendingEntryKey={pendingSponsoredEntryKey}
                          walletConnected={walletConnected}
                          walletBusy={walletBusy}
                          onConnectWallet={onConnectWallet}
                          onRevokeEntry={onRevokeSponsoredEntry}
                        />
                      ) : row?.id === "classic_extra_signers" || row?.id === "classic_thresholds" ? (
                        <PermissionRowDetails health={health} row={row} action={action} />
                      ) : (
                        <p>{row?.detail ?? copy.detail}</p>
                      )}
                      {row && row.id !== "classic_sponsorship" ? (
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
              {group.id === "open-positions" ? <ProtocolReviewRows health={health} /> : null}
            </div>
          </details>
        ))}
      </div>
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
  const [destinationModalOpen, setDestinationModalOpen] = useState(false);
  const [destinationDraft, setDestinationDraft] = useState("");
  const [didAutoloadQueryAccount, setDidAutoloadQueryAccount] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [trustlineSummary, setTrustlineSummary] = useState<TrustlineCleanupSummary | null>(null);
  const [pendingClassicAction, setPendingClassicAction] = useState<BlockerCode | null>(null);
  const [pendingSponsoredEntryKey, setPendingSponsoredEntryKey] = useState<string | null>(null);
  const trustlinePlannerRef = useRef<HTMLDivElement | null>(null);

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
      setPendingClassicAction(null);
      setPendingSponsoredEntryKey(null);
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
    setPendingClassicAction(null);
    setPendingSponsoredEntryKey(null);
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
      setPendingClassicAction(code);
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
        setPendingClassicAction(null);
      }
    },
    [health, network, source, walletAddress, refreshHealth, signSubmitClassicBatch],
  );

  const revokeSponsoredEntry = useCallback(
    async (entry: SponsoredLedgerEntry) => {
      const id = source.trim();
      if (!health?.horizonUrl || !walletAddress || !isValidClassicAddress(id)) return;
      const key = sponsorshipEntryKey(entry);
      setWalletBusy(true);
      setPendingSponsoredEntryKey(key);
      setWalletError(null);
      setActionSuccess(null);
      try {
        const batch = await buildRevokeSponsorshipEntryXdr({
          horizonUrl: health.horizonUrl,
          sponsorAccountId: id,
          network,
          entry,
        });
        const { hash } = await signSubmitClassicBatch(batch);
        setActionSuccess(`Sponsorship revoked. Tx ${hash.slice(0, 10)}... Re-run health when Horizon catches up.`);
        await refreshHealth();
      } catch (e) {
        setWalletError(formatWalletError(e));
      } finally {
        setWalletBusy(false);
        setPendingSponsoredEntryKey(null);
      }
    },
    [health?.horizonUrl, network, refreshHealth, signSubmitClassicBatch, source, walletAddress],
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
  const nativeBalanceLabel =
    typeof health?.nativeBalanceXlm === "number" ? formatXlmCompact(health.nativeBalanceXlm) : "Balance unavailable";
  const trustlineStateLabel =
    trustlineSummary
      ? `${trustlineSummary.total} token line${trustlineSummary.total === 1 ? "" : "s"}`
      : checklistById.get("classic_trustlines")?.status === "pass"
        ? "None detected"
        : "Needs cleanup";
  const destinationStateLabel = destOk ? "Set" : "Missing";
  const reviewBeforeCloseCount = permissionReviewCount + protocolReviewCount + (destOk ? 0 : 1);
  const manualReviewStateLabel =
    reviewBeforeCloseCount === 0
      ? "No review flags"
      : `${reviewBeforeCloseCount} item${reviewBeforeCloseCount === 1 ? "" : "s"} to review`;
  const closeReadinessLabel =
    health?.canDemolish && destOk
      ? "Ready to close"
      : !destOk
        ? "Destination missing"
        : blocking.length > 0
          ? "Cleanup first"
          : "Review first";
  const compactTrustlineCount = trustlineSummary?.total ?? (trustlineChecklistRow?.status === "pass" ? 0 : 1);
  const focusTrustlinePlanner = useCallback(() => {
    setActiveSection("scan");
    window.requestAnimationFrame(() => {
      trustlinePlannerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      const firstToken = trustlinePlannerRef.current?.querySelector("details.trustlineToken") as HTMLDetailsElement | null;
      if (firstToken) firstToken.open = true;
    });
  }, []);

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
          onClick: focusTrustlinePlanner,
        }
      : sponsorshipNeedsAction
        ? {
            eyebrow: "Next best action",
            title: "Revoke sponsored reserves",
            body: "This account is paying reserve for sponsored ledger entries that must be cleared before close.",
            actionLabel: "Review sponsorships",
            tone: "state",
            onClick: () => {
              setActiveSection("scan");
              window.requestAnimationFrame(() => {
                document.querySelector(".stateDetailGroup--account-states")?.scrollIntoView({ behavior: "smooth", block: "start" });
              });
            },
          }
        : !destOk
          ? {
              eyebrow: "Next best action",
              title: "Save destination address",
              body: "Close flow needs a verified destination before final wallet approval.",
              actionLabel: "Save destination",
              tone: "close",
              onClick: openDestinationModal,
            }
          : {
              eyebrow: "Next best action",
              title: "Review final close flow",
              body: "Required cleanup is clear enough to move into destination and irreversible-close review.",
              actionLabel: "Open close flow",
              tone: "close",
              onClick: () => setActiveSection("close"),
            };

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
                        <div className={`snapshotStatusStrip ${health.canDemolish ? "snapshotStatusStrip--ok" : "snapshotStatusStrip--warn"}`}>
                          <span>
                            {blocking.length} blocker{blocking.length === 1 ? "" : "s"}
                          </span>
                          <span>
                            {compactTrustlineCount} token line{compactTrustlineCount === 1 ? "" : "s"}
                          </span>
                          <span>Destination {destinationStateLabel.toLowerCase()}</span>
                        </div>
                      </div>
                    </div>

                    <div className="snapshotBandGrid">
                      <article className="snapshotBand snapshotBand--state">
                        <span className="snapshotEyebrow">Cleanup blockers</span>
                        <strong className="snapshotValue">
                          {blocking.length > 0 ? `${blocking.length} blocker${blocking.length === 1 ? "" : "s"}` : accountStateLabel}
                        </strong>
                        <p className="snapshotSentence">
                          {blocking.length > 0
                            ? blocking
                                .slice(0, 2)
                                .map((blocker) => blocker.title)
                                .join(", ")
                            : "No required cleanup blockers were returned by the latest scan."}
                        </p>
                        <div className="snapshotList">
                          <div>
                            <span>Balance</span>
                            <strong>{nativeBalanceLabel}</strong>
                          </div>
                          <div>
                            <span>Open positions</span>
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
                        <span className="snapshotEyebrow">Close readiness</span>
                        <strong className="snapshotValue">{closeReadinessLabel}</strong>
                        <p className="snapshotSentence">
                          Final close stays unavailable until cleanup blockers are resolved and a destination is set.
                        </p>
                        <div className="snapshotList">
                          <div>
                            <span>Review checks</span>
                            <strong>{manualReviewStateLabel}</strong>
                          </div>
                          <div>
                            <span>Destination status</span>
                            <strong>{destinationStateLabel}</strong>
                          </div>
                        </div>
                      </article>
                    </div>
                  </section>

                  {nextBestAction ? (
                    <section className={`nextActionStrip nextActionStrip--${nextBestAction.tone}`}>
                      <div>
                        <span>{nextBestAction.eyebrow}</span>
                        <strong>{nextBestAction.title}</strong>
                        <p>{nextBestAction.body}</p>
                      </div>
                      <button type="button" className="btn primary" onClick={nextBestAction.onClick}>
                        {nextBestAction.actionLabel}
                      </button>
                    </section>
                  ) : null}

                  <AccountStateDetails
                    embedded
                    health={health}
                    checklist={checklist}
                    walletConnected={Boolean(walletAddress)}
                    walletBusy={walletBusy}
                    onConnectWallet={connectWallet}
                    onCloseStep={() => setActiveSection("close")}
                    onSetDestination={openDestinationModal}
                    onTrustlinePlanner={focusTrustlinePlanner}
                    onResolveClassicBlocker={(code) => {
                      void resolveClassicBlocker(code);
                    }}
                    onRevokeSponsoredEntry={(entry) => {
                      void revokeSponsoredEntry(entry);
                    }}
                    pendingClassicAction={pendingClassicAction}
                    pendingSponsoredEntryKey={pendingSponsoredEntryKey}
                    destination={destination}
                    destOk={destOk}
                    reserveReleaseLabel={reserveReleaseLabel}
                    trustlinePanel={
                      showTrustlineTeardown && health.horizonUrl ? (
                        <div ref={trustlinePlannerRef} className="trustlinePlannerAnchor">
                          <TrustlineTeardownCard
                            embedded
                            inlineList
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
                        </div>
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
              <span className="modalKicker">Close safely</span>
              <h2 id="destination-modal-title">Save destination address</h2>
              <p>
                This is where native XLM will be sent if you later approve the final account close. You can edit it before
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
  return route === "app" ? <AppShell /> : <LandingPage />;
}
