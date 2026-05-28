# Orbitway — Use cases, components, and external services

**Repo:** `/Users/piyush/Desktop/work/stellar`  
**Reference prior art:** [stellar.expert/demolisher/public](https://stellar.expert/demolisher/public) (Orbit Lens — classic-focused flow; use as UX/operation ordering reference, verify license before copying code).  
**Product requirements:** [SCF Account Demolisher RFP](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track#account-demolisher) (classic + Soroban, safety, non-custodial, mediator for CEX, etc.).

**Diagrams (kept in sync with code):** [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md) — component flow and health-check sequence.

This document describes **target** product behavior (RFP + roadmap) and **what exists in the repo today**, so gaps are explicit and not ambiguous.

---

## 0. Implementation status (snapshot)

| Requirement | Implemented | To be done |
|---|---|---|
| Check existing sponsorships; sponsored reserves block merge | Partial: health detects `num_sponsoring`; UI can build `RevokeSponsorship` batches for some Horizon-discoverable sponsored entries. | Handle all sponsored entry types reliably, especially sponsored data entries; improve multi-pass UX for >100 revokes. |
| Check multisig on account | Partial: health detects extra signers and non-merge-friendly thresholds. | Add full multisig workflow for gathering signatures from multiple wallets/keys. |
| Remove extra signers and set thresholds for further manipulation | Partial: removes extra ed25519 signers and sets `masterWeight: 1`, `low: 1`, `med: 0`, `high: 0`. | Support non-ed25519 signer types such as hash/preauth signers; add clearer staged signing flow. |
| Remove all trustlines | Partial: removes zero-balance classic trustlines; positive balances can be handled asset-by-asset through sell or payout + `ChangeTrust(0)`. | Fully automate non-zero trustline cleanup; add routing when direct XLM order book/Soroswap route is unavailable. |
| Remove account data entries | Partial: builds `ManageData` delete batches up to 100 entries. | Multi-pass progress UX; better handling for sponsored data entries. |
| Optionally claim selected claimable balances | Partial: detects inbound claimable balances and can claim them in batches. | Let users select which balances to claim instead of batch-claiming all. |
| Close all open positions: DEX offers, AMM/LP stakes, DeFi positions | Partial: cancels SDEX offers; withdraws classic LP shares; reads Blend backstop exposure; Aquarius/Soroswap are mostly static/unknown. | Build real DeFi position adapters and unwind transactions for Blend, Aquarius, Soroswap, and other key protocols. |
| Sell all classic and Soroban tokens to target base asset | Partial: classic trustline sell vs XLM using direct SDEX book; optional Soroswap classic-to-native swap XDR when configured. | Support user-specified base asset, path routing, Soroban-only tokens, multi-leg swaps, and full portfolio liquidation. |
| Option to send remaining non-XLM balances to third-party wallet/exchange | Partial: per-trustline payout can send classic asset balance to a user-confirmed G-address. | Add full third-party/exchange payout flow, memo/tag handling, and better unsupported-asset routing. |
| Merge account and send remaining funds to destination using temporary mediator for CEXes | Partial: plain `ACCOUNT_MERGE` to existing G-address is implemented. | Build mediator account flow for CEX/exchange destinations that cannot receive `ACCOUNT_MERGE`; add final balance preview. |
| View active token allowances / authorizations without removing account | Partial: checks configured Soroban SAC spender allowances inside health report. | Add dedicated inspect-only mode; discover all active allowances/authorizations, not just configured spenders. |
| Soroban support with full parity to classic assets | Partial: SAC balance scan and limited allowance scan exist. | Full Soroban token discovery, teardown, allowance revoke, DeFi unwind, and routing parity. |
| UI supports stellar-wallets-kit and direct secret key input | Partial: Stellar Wallets Kit is integrated for wallet connect/signing. | Add direct secret key input, multiple secret keys, multiple wallet signing, and multisig transaction assembly. |
| Trust-minimized, non-custodial implementation; all signing client-side; secrets never server-side | Mostly yes for current scope: API is read/read-proxy only; signing happens in browser via Wallets Kit. | Preserve this for future direct secret input and mediator flows; add explicit security docs and tests to ensure secrets never hit API/logs. |
| Safety features: confirmations, warnings, dry-run/preview mode | Partial: basic warnings and wallet confirmation exist; README proposes rolling dry-run approach. | Implement transaction plan preview, per-step simulation, explicit confirmations, slippage warnings, failure recovery, and post-tx refresh. |
| Open source, permissive license; stellar.expert/demolisher can be starting point | Partial: repo is open-source in structure, docs reference prior art. | Confirm/add permissive license file; verify stellar.expert code license before reusing any code. |
| Production-grade UX for irreversible actions | Partial: app has health checklist and guided cleanup actions. | Add polished production flows: staged plan, clear risk states, selection controls, recoverable progress, audit trail, better error handling, and deployment hardening. |

---

## 1. Goals (engineering)

1. **Scan** a Stellar account (classic + Soroban surface) and produce a **structured report** of blockers and optional cleanup. *(**Partially done:** health report + checklist + `openPositions`.)*  
2. **Plan** an ordered sequence of transactions (phases) with **human-readable preview** and **simulation** where possible. *(**Not done.**)*  
3. **Execute** under user control: **client-side signing** only (default: wallets-kit; advanced: local secret with extreme warnings). *(**Partial:** Wallets Kit connected in UI; several **classic** cleanup flows sign + submit from Step 3; Soroban/DeFi writes not built.)*  
4. **Exit** value to a destination: **merge** when possible; **mediator** path when destination cannot accept `ACCOUNT_MERGE`. *(**Not done.**)*  
5. **Soroban parity** over time via **protocol adapters** (Blend, Aquarius, Soroswap, … per RFP). *(**Started:** Blend read-only adapter in API; others TBD.)*  
6. **Inspect-only** path: allowances / authorizations / positions **without** teardown. *(**Partial:** allowances appear inside health when env configured; no standalone “inspect app” mode.)*

Non-goals for the **first vertical slice** remain: custodial signing, server-held keys, opaque “approve all” (see §6).

---

## 2. User personas & use cases

### 2.1 Personas

| Persona | Needs |
|---------|-------|
| **Retail user** | Close stale account; recover reserve; simple wallet connect; clear warnings. |
| **CEX user** | Send consolidated value to deposit address; **no merge** at CEX → mediator flow. |
| **Multisig participant** | See threshold/signers; co-sign across devices/wallets; export partial XDR if needed. |
| **DeFi user** | Unwind Blend / LP / DEX positions; revoke or inspect allowances after exploit concern. |
| **Wallet / support** | Deep links to “health check” only; reproducible steps for support tickets. |
| **Developer** | Self-host; configure Horizon/RPC URLs; extend adapters. |

### 2.2 Use case catalog

| ID | Use case | Mode | Primary outcome | In repo today |
|----|-----------|------|-----------------|---------------|
| UC-01 | **Account health scan** | Read-only | Report: balances, trustlines, offers, signers, thresholds, sponsorship, claimable balance count, data entries, Soroban SAC balances, DeFi checklist | **Yes**, minus “full position API”; Blend DeFi **read** on health path |
| UC-02 | **Inspect allowances / authorizations** | Read-only | List Soroban allowance-style state | **Partial** — subset of SAC allowances for configured spenders, embedded in health report; not a full authz explorer |
| UC-03 | **Classic cleanup only** | Write | Cancel offers → … | **Partial** — subset of classic teardown in Step 3 (see §0); no router/sell, no merge |
| UC-04 | **Exit to XLM (or chosen base)** | Write | Router / path payments | **No** |
| UC-05 | **Full demolish + merge to G-address** | Write | Cleanup + merge | **No** |
| UC-06 | **Demolish + CEX / no-merge destination** | Write | Mediator | **No** |
| UC-07 | **Multisig teardown** | Write | Multi-sign | **No** |
| UC-08 | **Soroban protocol unwind** | Write | Adapter unwind txs | **No** (read-only Blend signal only) |
| UC-09 | **Stop before merge** | Write | Cleanup without merge | **No** |

**Reference alignment (stellar.expert/demolisher/public):** public demolisher historically centers on **classic** teardown and merge-style flows. This repo extends that mental model with **explicit phases**, **Soroban**, **mediator**, and **inspect-only** RFP requirements.

---

## 3. High-level components

### 3.1 Target architecture (product / RFP)

Long-term, the SPA talks to a **core engine** (snapshot, planner, router, adapters) and optional **position backend**. Logical diagram (aspirational):

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web application (SPA)                     │
│  ┌──────────┐ ┌──────────────┐ ┌────────────┐ ┌───────────────┐ │
│  │ Wallet UI│ │ Scan / Report│ │ Plan/Preview│ │ Step executor │ │
│  └────┬─────┘ └──────┬───────┘ └──────┬─────┘ └───────┬───────┘ │
│       └──────────────┴──────────────┴─────────────────┘         │
│                         │                                        │
│              ┌──────────▼──────────┐                             │
│              │   Core engine (TS)   │                             │
│              │ snapshot · planner   │                             │
│              │ router · adapters    │                             │
│              └──────────┬───────────┘                             │
└─────────────────────────┼───────────────────────────────────────┘
                          │ HTTPS
     ┌────────────────────┼────────────────────┐
     ▼                    ▼                    ▼
 Horizon            Soroban RPC         Position API backend (RFP)
```

**Maintained Mermaid version** (includes **current** Fastify modules and external systems): [ARCHITECTURE_DIAGRAMS.md §1](./ARCHITECTURE_DIAGRAMS.md#1-high-level-components-and-interactions).

### 3.2 As implemented (this repo)

| Piece | Location | Role |
|-------|----------|------|
| **Web SPA** | `apps/web` (Vite, React, `@stellar/core` types/helpers) | Health UX; proxies `/api` to API in dev ([vite.config.ts](../apps/web/vite.config.ts)) |
| **Read-only BFF** | `services/api` (Fastify, `@stellar/core`, `@stellar/stellar-sdk`, `@blend-capital/blend-sdk`) | Horizon + Soroban + Blend reads; **no** signing or secrets |
| **Shared report logic** | `packages/core` (`health.ts`, `positions.ts`, …) | `buildHealthReport`, checklist rules, `DefiProtocolSurface`, LP extraction |
| **Horizon client** | `services/api/src/horizon.ts`, `fetchClassicPositions.ts` | Account fetch, offers, `hasOpenOffers` |
| **Soroban SAC scan** | `services/api/src/sorobanScan.ts` | RPC + SDK reads for SAC balances / allowances |
| **DeFi scan (Blend)** | `services/api/src/defiScan.ts` | Blend backstop + reward-zone pools via SDK → same Soroban RPC |
| **Protocol adapters package** | *Not a separate workspace* | Blend logic lives in API; future adapters may move to `packages/` |

---

## 4. External services & APIs

### 4.1 Required (network) — in use

| Service | Purpose (today) | Default base (override via env on API) |
|---------|-----------------|----------------------------------------|
| **Horizon** | Classic account JSON, offers for seller, existence checks | `horizon-testnet.stellar.org` / `horizon.stellar.org`; single URL if `HORIZON_URL` set → `ledgerNetwork: "custom"` |
| **Soroban RPC** | `getLedgerEntries` (and related reads for SAC + Blend SDK) | Public SDF RPC per `?network=`; single URL if `SOROBAN_RPC_URL` set |

Classic **transaction submit** is not performed by this repo’s API (no merge, no cancel); Horizon is used for **reads** only.

### 4.2 Required by RFP (program) — not wired

This subsection lists **where** DEX offers, LP/AMM stakes, and Soroban DeFi exposure can be discovered when wiring the handbook deliverable or expanding beyond the repo’s current reads. Nothing here is a commitment to implement every surface; prefer **Horizon + Soroban RPC + official SDKs/docs** before opaque aggregators.

#### Program / handbook aggregator (RFP)

| Service | Purpose |
|---------|---------|
| **DeFi position API (handbook-listed)** | Aggregated positions when pure RPC or many protocols make client-side discovery heavy; **not integrated** in this repo. Blend backstop exposure is already approximated via on-chain reads (`defiScan.ts`); a program API could still add Aquarius/Soroswap position depth, indexing, or CEX-style summaries. |

#### Classic SDEX (“DEX”) offers — Horizon REST

| What | API | Notes |
|------|-----|--------|
| All open offers for an account (seller) | `GET /accounts/{account_id}/offers` | Cursor-paginated collection; each record includes `id`, `paging_token`, `selling` / `buying` assets, `amount`, `price`, flags — sufficient to build **ManageSellOffer** / **ManageBuyOffer** cancel ops. |
| Horizon reference | [Horizon API — resources](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources) | Account-scoped offers follow `GET /accounts/{account_id}/offers` (see Horizon “accounts” / “offers” resource docs in that index). |

#### Classic AMM / LP stakes — Horizon REST

| What | API | Notes |
|------|-----|--------|
| LP share balances | `GET /accounts/{account_id}` → `balances[]` | Rows with `asset_type: "liquidity_pool_shares"` include `liquidity_pool_id` (CAP-38) and `balance` (share units). |
| Pool metadata / reserves | `GET /liquidity_pools/{liquidity_pool_id}` | Reserve amounts, `total_shares`, pool type, fee — useful for UX copy and unwind planning. |
| Horizon reference | [Horizon API — resources](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources) | Use the **liquidity pools** and **accounts** sections for request/response fields. |

#### Soroban DeFi — main protocols (Blend, Aquarius, Soroswap)

| Protocol | API / integration surface | Position-relevant notes |
|----------|---------------------------|-------------------------|
| **Blend** (lending / backstop) | **Soroban RPC** (`getLedgerEntries`, simulations) + **`@blend-capital/blend-sdk`** ([npm](https://www.npmjs.com/package/@blend-capital/blend-sdk)) | Repo already loads **v2 backstop** and **reward-zone** pools per network; user rows via `BackstopPoolUser`. **Not covered here:** lending positions outside the configured backstop/reward-zone model — may need extra pool lists or indexer. |
| **Aquarius** (Soroban AMM / farms) | **Soroban** contract calls per [Aquarius developer docs](https://docs.aqua.network/developers/integrating-with-aquarius) and [Soroban functions](https://docs.aqua.network/developers/aquarius-soroban-functions); code examples (e.g. [pool info](https://docs.aqua.network/developers/code-examples/get-pools-info)) | No first-party “positions by G-address” REST documented as a single URL — discovery is typically **router/pool contracts + RPC** (and optional future indexer). Contract entrypoints referenced in-repo for UX: see `defiProtocolSurfacesForNetwork` in `packages/core/src/positions.ts`. |
| **Soroswap** (DEX / aggregator on Soroban) | **HTTPS API** + TypeScript SDK: [Soroswap API docs](https://docs.soroswap.finance/soroswap-api), [GitHub `soroswap/sdk`](https://github.com/soroswap/sdk) — API base defaults to `https://api.soroswap.finance` (API key registration per their docs). | Suitable for **quotes, pool metadata, and tx building** from a server BFF if you accept API-key custody on the backend. Alternatively mirror their **on-chain** approach with Soroban RPC + published factory/router `C…` addresses (see `positions.ts`). |

**Summary:** use **Horizon** for classic SDEX + CAP-38 LP; use **Soroban RPC (+ Blend SDK)** for Blend; plan **Aquarius** via their Soroban integration guides; plan **Soroswap** via their documented API/SDK or direct contract reads. Align any **handbook-listed** aggregator with the same primitives so the product can cross-check indexer data against chain.

### 4.3 Optional / routing & UX

| Service | Purpose | Note |
|---------|---------|------|
| **Stellar TOML / federation** | Resolve `user*domain` destinations | Optional |
| **Anchor / asset metadata** | Display asset names, home domains | Horizon + TOML |
| **Price / route aggregators** | Improve swap quotes | Not used |

### 4.4 Wallet & signing

| Integration | Purpose | Status |
|-------------|---------|--------|
| **@creit.tech/stellar-wallets-kit** | Freighter, WalletConnect, etc. | **Integrated in `App.tsx`** (connect / profile / disconnect); optional WalletConnect via `VITE_WALLETCONNECT_PROJECT_ID`; automated signed flows for blockers still **not** built |
| **Local secret (advanced)** | Multisig or legacy flows | **Not implemented** |

### 4.5 Prior art code (optional fork)

| Source | Use |
|--------|-----|
| **stellar.expert/demolisher** | Reference for classic operation ordering — confirm **license** before reuse |

---

## 5. Data contracts

### 5.1 Conceptual `AccountSnapshot` / teardown types (roadmap)

The RFP-oriented model still applies for **future** planner + executor work:

- `accountId`, `network`  
- Classic: `balances[]`, trustlines, offers, data entries, signers, thresholds, sponsorship, claimable balances  
- Soroban: normalized token balances, allowances  
- `defiPositions[]` from APIs + adapters  
- `mergeBlockers[]`, `readiness` / phases  

### 5.2 Implemented: `HealthReport` and friends

The live API and web app use **`HealthReport`** from `@stellar/core` (see `packages/core/src/health.ts`):

- **Top level:** `accountId`, `checklist[]`, `blockers[]`, `canDemolish`, `summary`, `ledgerNetwork`, `horizonUrl`, `sorobanRpcUrl`, `nativeBalanceXlm`, `sequence`  
- **`checklist`:** rows such as `account_exists`, `classic_open_offers`, `classic_amm_lp_shares`, `soroban_sac_balances`, `soroban_allowances`, `defi_positions`, …  
- **`openPositions` (when account exists on health path):** `sdexOffers` (may be empty on monolithic health while offer **count** still drives checklist), `liquidityPoolShares` (often derived from Horizon balances inside `buildHealthReport`), `defiProtocols[]` (**Blend scanned** + Aquarius/Soroswap static surfaces)  
- **`soroban`:** `SorobanScanResult` — RPC URL, `ok`, SAC balance rows, allowance rows, `allowanceCheckIncomplete` when spenders env unset  

Split endpoints return slices that can be merged client-side (see `apps/web/src/mergeHealthFromSlices.ts`) to approximate the same report.

### 5.3 `TeardownPlan` / `ExecutionSession` (roadmap)

- **`TeardownPlan`:** ordered phases/steps, simulation hints — **not implemented**  
- **`ExecutionSession`:** resume / tx hashes — **not implemented**

### 5.4 Trustline removal policy (classic)

1. **Per-asset choice when balance is positive:** Offer an optional **sell on the classic SDEX** using a **snapshot-derived** reference price from Horizon (direct **order book** for the asset vs a counter asset — today **XLM** only in the app — best bid) with explicit **slippage / min-out** style limits on the limit price. Enable the sell path only when the book shows **meaningful liquidity**; otherwise surface **“not listed / too thin”** and do not pretend a route exists. **Path / router-based** exits when there is no direct book remain **TODO** (not Soroban DeFi unwind).
2. **Unsold remainder or user skips sell:** **`Payment`** of the **full remaining** credit balance to a **user-confirmed payout target**. Default suggestion in UI: the **asset issuer** from the trustline, with a **strong disclaimer** that issuers may not accept unsolicited returns and may use **auth / clawback** — the user must confirm before signing.
3. **After balance is zero** and there are **no blocking offers** on that asset line: **`ChangeTrust` with limit `0`** removes the trustline. (The app may combine **payment + `ChangeTrust`** in one transaction when paying away the full balance.)
4. **Sponsorship:** Resolve **sponsored reserve** relationships in the right order (e.g. **revoke sponsorship** where applicable, or ensure the sponsored account can authorize reserve-releasing ops) before expecting **`ChangeTrust`** to free subentries — mismatched ordering surfaces as Horizon errors.
5. **Flags (auth / clawback):** **Precheck** issuer account flags when possible; otherwise rely on Horizon **submit** errors and clear copy.

---

## 6. Phased implementation map (repo milestones)

| Milestone | Scope | Key APIs | Status |
|-----------|-------|----------|--------|
| **M0 — Repo & config** | npm workspaces, env for Horizon/RPC | — | **Done** |
| **M1 — Scan only** | UC-01, UC-02 partial | Horizon + Soroban RPC + Blend SDK (DeFi subset) | **In progress** — health + split routes; gaps: claimables, full offers on health path, Aquarius/Soroswap reads |
| **M2 — Classic execute** | UC-03, UC-05 (merge only) | Horizon (submit via wallet) | **Not started** |
| **M3 — Routing** | UC-04 classic | Horizon paths | **Not started** |
| **M4 — Mediator** | UC-06 | Horizon | **Not started** |
| **M5 — Position backend + API** | Wire handbook-listed position API | HTTPS backend | **Not started** |
| **M6 — Soroban adapters** | UC-08 reads + writes | RPC + adapters | **Partial reads** (Blend); **no unwind txs** |
| **M7 — Hardening** | Tests, audit prep | All | **Ongoing** |

**Out of scope until core stable:** custodial relay signing, server-side key storage, hiding transaction details behind one opaque “Approve all”.

---

## 7. Repository layout (actual)

```
stellar/
├── docs/
│   ├── ORBITWAY_USECASES_AND_COMPONENTS.md   # this file
│   └── ARCHITECTURE_DIAGRAMS.md                       # Mermaid: components + health sequence
├── apps/
│   └── web/                    # @stellar/web — Vite + React + TS
├── packages/
│   └── core/                   # @stellar/core — health report, positions, types
├── services/
│   └── api/                    # @stellar/api — Fastify BFF
├── README.md
└── package.json                # workspaces: apps/*, packages/*, services/*
```

There is **no** separate `packages/classic`, `packages/soroban`, `packages/adapters`, or `services/position-proxy` yet — add them only when extracted from `api` / `core` for clarity.

---

## 8. Configuration & secrets (ops)

Values below match **`services/api/README.md`**. The API reads them from the **process environment** (not `PUBLIC_*` in the browser for Horizon/RPC — the browser calls same-origin `/api`, and the server applies env).

| Config | Where | Secret? |
|--------|-------|---------|
| `HORIZON_URL` | API process | No — if set, overrides per-request testnet/mainnet bases |
| `SOROBAN_RPC_URL` | API process | No — if set, overrides both networks’ RPC |
| `SOROBAN_ALLOWANCE_SPENDERS` | API process | No — comma-separated `C…` contract IDs |
| `PORT`, `HOST` | API process | No |
| `LOG_UPSTREAM`, `LOG_UPSTREAM_BODY` | API process | No |

**Web:** no env-required for health if Vite proxy targets local API; optional `VITE_*` vars follow `apps/web` conventions.

**Future (M5):** if a handbook-listed position API requires a key, keep it **server-side only**; never expose to the browser.

---

## 9. Open decisions (track in issues)

1. **Handbook-listed position API:** confirm URL + schema when M5 starts (may complement or replace part of RPC-only discovery).  
2. **Mediator:** minimum XLM funding model, key generation (WebCrypto), CEX memo/tag templates per exchange.  
3. **Fork vs greenfield** for classic teardown logic relative to stellar.expert/demolisher.  
4. **README / docs drift:** keep root README and this file aligned when adding features (e.g. DeFi read path, wallet connect).

**Resolved (was ambiguous in earlier draft):**

- **Monorepo tool:** npm workspaces (root `package.json`).  
- **Frontend:** React + Vite in `apps/web`.  
- **Backend stack for read BFF:** Fastify + TypeScript in `services/api`.  
- **Where “adapters” live for now:** Blend DeFi read logic in `services/api/src/defiScan.ts` (not a separate `packages/adapters` workspace).

---

## 10. References

- [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md) — component and sequence diagrams  
- [services/api/README.md](../services/api/README.md) — routes and env  
- [stellar.expert/demolisher/public](https://stellar.expert/demolisher/public)  
- [Orbitway product requirements (SCF Account Demolisher RFP)](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track#account-demolisher)  
- [Horizon API](https://developers.stellar.org/docs/data/horizon) · [Horizon resource reference](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources)  
- [Soroban RPC](https://developers.stellar.org/docs/data/rpc)  
- [stellar-wallets-kit](https://github.com/stellar/stellar-wallets-kit)  
- [Blend SDK](https://www.npmjs.com/package/@blend-capital/blend-sdk) (used in API for backstop reads)  
- [Aquarius developers](https://docs.aqua.network/developers/integrating-with-aquarius)  
- [Soroswap API](https://docs.soroswap.finance/soroswap-api) · [soroswap/sdk](https://github.com/soroswap/sdk)

---

**Document history**

| Date | Change |
|------|--------|
| 2026-05-14 | Initial use case & component spec for `work/stellar` repo |
| 2026-05-14 | Aligned with implemented API/web/core: §0 status, UC table, actual repo layout, env names, HealthReport vs roadmap types, M1/M6 status, architecture doc link, open decisions |
| 2026-05-14 | §4.2: expanded RFP/program APIs — Horizon SDEX + LP, Blend / Aquarius / Soroswap integration surfaces |
| 2026-05-14 | §0 / §1 / §4.4: Wallets Kit connected in `App.tsx`; README gap table aligned |
| 2026-05-15 | §0: classic sponsorship revoke (Horizon + Wallets Kit) in web; README production table |
| 2026-05-15 | §5.4 **Trustline removal policy**; §5.3 restored; §0 table (trustline card, `order-book` route); README alignment |
