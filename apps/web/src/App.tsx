import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
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

type RouteMode = "landing" | "app";

const HEALTH_FETCH_TIMEOUT_MS = 90_000;

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

function AppShell() {
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

  useEffect(() => {
    document.title = "Stellar Sweep | App";
  }, []);

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
    <div className="page">
      <header className="topbar topbar--app">
        <div className="brand">
          <span className="brandMark" aria-hidden />
          <div>
            <div className="brandName">Stellar Sweep</div>
            <div className="brandTag">Account scan and cleanup workspace.</div>
          </div>
        </div>
        <nav className="nav">
          <NavLink href="/">Landing page</NavLink>
        </nav>
      </header>

      <main className="workspace">
        <section className="workspaceHero">
          <div>
            <SectionKicker>App workspace</SectionKicker>
            <h1>Inspect a Stellar account and see what blocks safe exit.</h1>
            <p>
              Use the health scanner to review blockers, then continue toward a safe merge when the account is ready.
            </p>
          </div>
          <div className="workspaceStat">
            <span>Mode</span>
            <strong>{network}</strong>
          </div>
        </section>

        <ol className="steps">
          <li className="active">1. Source &amp; health</li>
          <li className={accountKnown ? "active" : ""}>2. Destination</li>
          <li className={accountKnown ? "active" : ""}>3. Resolve blockers</li>
          <li className={canDemolish ? "active" : ""}>4. Demolish</li>
        </ol>

        <section className="cardGrid">
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
                  Rows show pass, skipped, failed, blocker, inconclusive, or N/A, depending on what the scan can prove.
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
              <h2 className="cardTitle">Step 2 — Merge destination</h2>
              <p className="hint">
                Where remaining XLM should go after cleanup. Merge stays locked until blocking issues are cleared.
              </p>
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
        </section>

        {accountKnown || info.length > 0 ? (
          <section className="cardGrid">
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
          </section>
        ) : null}
      </main>
    </div>
  );
}

export function App() {
  const route = useRouteMode();
  return route === "app" ? <AppShell /> : <LandingPage />;
}
