# Stellar — Account Demolisher monorepo

**npm workspaces**: **web** (Vite + React + TS), **API** (Fastify + TS), **core** (shared types/logic).

pnpm is **not** required. Any recent **npm** (7+) handles `workspaces` in the root `package.json`.

## Requirements

- **Node.js 20+**
- **npm 10+** (ships with current Node LTS)

## Install

```bash
cd /Users/piyush/Desktop/work/stellar
npm install
```

This installs root + all workspaces and links `@stellar/core` into `apps/web` and `services/api`.

## Scripts (root)

| Command | Description |
|---------|-------------|
| **`npm run dev:all`** | **Start web + API together** (use this for health checks). |
| `npm run dev` | Vite only (port **5173**) — `/api` proxy will **fail** unless API is running separately. |
| `npm run dev:api` | Fastify API only (port **8787**) |
| `npm run build` | Runs `build` in each workspace that defines it |
| `npm run typecheck` | Runs `typecheck` in each workspace that defines it |

## Networks (testnet & mainnet)

Health checks use **Horizon** for whichever network you pick in the UI (**Testnet** / **Mainnet**). The API maps those to `horizon-testnet.stellar.org` and `horizon.stellar.org` unless `HORIZON_URL` is set (then that URL is used for every request). See [services/api/README.md](services/api/README.md).

Soroban reads use **testnet** `https://soroban-testnet.stellar.org` and **mainnet** `https://soroban-rpc.mainnet.stellar.gateway.fm` by default (the `soroban-rpc.mainnet.stellar.org` hostname does not resolve). Set **`SOROBAN_RPC_URL`** to point both networks at your own RPC if needed.

## Layout

```
stellar/
├── apps/web/              # SPA — @stellar/web
├── services/api/          # Read-only BFF — @stellar/api (proxies /api from Vite)
├── packages/core/       # Shared — @stellar/core (exported from src for dev)
├── docs/
└── package.json          # workspace root + workspaces[]
```

## Stellar dependencies

- **`@stellar/stellar-sdk`** — classic + RPC helpers (`apps/web` for now; move shared calls to `core` later).
- **`@creit.tech/stellar-wallets-kit`** — Stellar Wallets Kit on npm ([stellarwalletskit.dev](https://stellarwalletskit.dev/)).

## Docs

- [Use cases & components](docs/ACCOUNT_DEMOLISHER_USECASES_AND_COMPONENTS.md) — includes **§5.4 Trustline removal policy** (sell vs snapshot book, payout + `ChangeTrust`, sponsorship / flags).

---

## Production requirements (status)

This section tracks **Account Demolisher** scope against the full production spec so work can be resumed without re-deriving gaps. Last reviewed from the codebase and docs in-repo (not a legal/compliance sign-off).

### Implemented (today)

| Requirement | Status | Notes |
|-------------|--------|--------|
| **Detect sponsorships** (`num_sponsoring`) | **Read-only check** | `packages/core/src/health.ts` — checklist row fails if the account sponsors other reserves. |
| **End classic sponsorship (RevokeSponsorship)** | **Partial** | `apps/web/src/sponsorshipRevoke.ts` + Step 3 when blocking `SPONSORING_OTHER_ACCOUNTS`: paginates Horizon (`claimable_balances`, `offers`, `liquidity_pools`, `accounts` with `?sponsor=`), builds up to **100** revoke ops per transaction, signs with Wallets Kit, submits. **Gaps:** sponsored **data** entries are not reliably listed with sponsor in account JSON; more than 100 revokes requires multiple runs. |
| **Remove extra signers / merge-friendly thresholds** | **Partial** | `apps/web/src/classicDemolish.ts` (`buildMergeFriendlySignersAndThresholdsBatchXdr`) + Step 3 for `MULTISIG_OR_EXTRA_SIGNERS` / `NON_DEFAULT_THRESHOLDS`: phase A removes up to 100 extra ed25519 signers per tx; phase B sets `masterWeight: 1`, `lowThreshold: 1`, `medThreshold: 0`, `highThreshold: 0`. Non-ed25519 signers (pre-auth, etc.) are not handled. |
| **Classic trustlines (zero balance only, batch)** | **Partial** | `classicDemolish.ts` + Step 3 for `TRUSTLINES_OR_ASSET_BALANCES`: `ChangeTrust` limit 0 for up to **100** empty lines per tx when **all** qualifying lines are zero (throws if any balance is positive). |
| **Classic trustlines (non-zero balance)** | **Partial** | `TrustlineTeardownCard` + `trustlineTeardown.ts` (between Steps 2–3 when trustlines block): optional **crossing `ManageSellOffer` vs XLM** from `GET /api/order-book` best bid + slippage bps; **Payment** (full Horizon balance string) + **`ChangeTrust` 0** to a **user-confirmed** payout (default issuer); issuer flag hints (auth/clawback). **Gaps:** no path/router; thin-book UX only; one asset per payout tx; **≤100** ops not needed for current single-pair txs. Policy: [docs/ACCOUNT_DEMOLISHER_USECASES_AND_COMPONENTS.md §5.4](docs/ACCOUNT_DEMOLISHER_USECASES_AND_COMPONENTS.md). |
| **Remove account `data` entries** | **Partial** | `ManageData` with `value: null` for up to 100 keys per tx; multiple runs if needed. |
| **Cancel open SDEX offers** | **Partial** | `GET /api/account/:id/offers` + `buildCancelSdexOffersXdr` (`classicClose.ts`); Step 3 when `OPEN_OFFERS`. More than 100 offers requires multiple runs. |
| **Withdraw AMM / liquidity pool shares** | **Partial** | Uses `health.openPositions.liquidityPoolShares` or fresh Horizon balances; `liquidityPoolWithdraw` with **min amounts 0** (high slippage — user must confirm in wallet). Step 3 when `OPEN_LIQUIDITY_POOL`. |
| **Inbound claimable balances** | **Partial** | Health path counts Horizon `claimable_balances?claimant=`; Step 3 **claim** batch (`Operation.claimClaimableBalance`) when `CLAIMABLE_BALANCES_PENDING`. If the Horizon scan fails, checklist shows **unknown** (merge blocked until re-run). |
| **Soroban SAC balances (native + trustline assets)** | **Partial scan** | API Soroban RPC reads SAC `Balance` ledger entries per Horizon asset list (`services/api/src/sorobanScan.ts`). Does not cover arbitrary custom Soroban-only assets with no classic trustline. |
| **Soroban token allowances (selected spenders)** | **Partial scan** | Simulates SAC `allowance` for contract IDs in `SOROBAN_ALLOWANCE_SPENDERS`; skipped if unset. Not a full allowance/authorization explorer. |
| **Horizon + Soroban RPC read path** | **Yes** | Network toggle, optional `HORIZON_URL` / `SOROBAN_RPC_URL` (`services/api/README.md`). |
| **UI: health checklist** | **Yes** | `apps/web/src/App.tsx` — pass/fail/unknown/skipped rows for scans the tool performs. |
| **Stellar Wallets Kit (connect)** | **Partial** | `App.tsx` + `walletKit.ts`: connect (auth modal), profile modal, disconnect; network follows UI testnet/mainnet; optional WalletConnect via `VITE_WALLETCONNECT_PROJECT_ID` in `apps/web/.env`. |
| **Non-custodial server (secrets)** | **Yes (so far)** | API only reads public Horizon/RPC; **no** secret submission endpoint. **Client-side signing:** Wallets Kit + `signTransaction`; classic cleanup paths above submit via `submitSignedClassicTx` (`classicClose.ts`). |

### Not implemented (production gaps)

| Requirement | Status | Notes |
|-------------|--------|--------|
| **Trustlines with non-zero balance (policy + UX)** | **Partial** | See **Classic trustlines (non-zero balance)** in Implemented; still no automated path when no SDEX book. |
| **Remove extra signers (non–ed25519 types)** | **No** | Pre-auth hashes, hashes(x), etc. are not automated. |
| **Close DeFi positions (Blend, Aquarius, Soroswap, …)** | **No** | Automated **unwind txs** not built; health includes **read-only** Blend backstop scan — still treat Aquarius/Soroswap manually until adapters claim them. |
| **Sell/rout all tokens (classic + Soroban) to a base asset** | **No** | Trustline card adds **direct SDEX book vs XLM** crossing sell only — no Soroban spend, no multi-hop path payment, no general router. |
| **Option: send non-XLM remainder to third-party wallet/exchange** | **Partial** | Trustline payout field supports any **classic G-address** with confirmation; not a full “router to CEX” product. |
| **Merge to destination + mediator pattern for CEX** | **No** | UI has a disabled “Demolish” placeholder; no `ACCOUNT_MERGE`, no temp mediator account flow. |
| **Dedicated “inspect only” mode for allowances + authorizations** | **No** | Allowance data appears inside the health JSON/checklist when configured; no separate read-only product mode or full authz surface (e.g. all Soroban auth entries). |
| **Soroban full parity with classic** | **No** | SAC-focused reads only; no general contract position discovery, Wasm token types beyond SAC pattern, etc. |
| **Per-blocker “Sign & resolve” in UI** | **Partial** | Classic paths in **Implemented** table (sponsorship, data, offers, LP, trustlines empty-only, signers/thresholds, claimables) are wired in Step 3 when the matching **blocking** code is present. **Soroban / DeFi / LOW_RESERVE** blockers are not automated here. |
| **Direct secret input + multiple keys / multi-wallet signing** | **No** | Not implemented. |
| **Safety: confirmations, warnings, dry-run / preview** | **No** | Informative copy in UI only; **no** staged confirmation, **no** dry-run or simulated tx plan. |

### Dry-run / preview (proposed approach)

Full demolition is inherently **multi-transaction** and **state-dependent** (each tx changes what the next simulation means). A practical approach:

1. **Plan object (client-built)** — After each Horizon/RPC snapshot, compute an ordered **queue of intended operations** (e.g. cancel offers N…M, remove data keys, change trust, Soroban revoke, merge). Store dependencies (“must run after X”).  
2. **Per-step simulation** — For each step, run **Horizon preconditions** + **`simulateTransaction`** (Soroban) with the **current** sequence number and expected account state; show **fee, footprint, and revert reason** without submitting.  
3. **User checkpoint** — After each submitted tx on-chain, **refresh snapshot** and **recompute** the remainder of the plan (dry-run again from new state).  
4. **“Preview merge”** — Final step: simulate `ACCOUNT_MERGE` (and any mediator payout txs) showing **post-merge destination balance delta** and **residual risks** (e.g. still-unknown DeFi).  
5. **Explicit “unknown unknowns”** — Any checklist row still `unknown` after simulation should **block** one-click demolition until resolved or user acknowledges with a separate, stronger confirmation.

Document this in product/UX copy so users expect **rolling preview**, not a single static dry-run for the whole lifecycle.

---
