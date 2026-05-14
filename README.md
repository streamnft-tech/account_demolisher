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

- [Use cases & components](docs/ACCOUNT_DEMOLISHER_USECASES_AND_COMPONENTS.md)

---

## Production requirements (status)

This section tracks **Account Demolisher** scope against the full production spec so work can be resumed without re-deriving gaps. Last reviewed from the codebase and docs in-repo (not a legal/compliance sign-off).

### Implemented (today)

| Requirement | Status | Notes |
|-------------|--------|--------|
| **Detect sponsorships** (`num_sponsoring`) | **Read-only check** | `packages/core/src/health.ts` — checklist row fails if the account sponsors other reserves; no tx to end sponsorships. |
| **Detect multisig / extra signers** | **Read-only check** | Same — fails if any signer other than the account itself; no signer removal txs. |
| **Detect non-merge-friendly thresholds** | **Read-only check** | Same — fails unless `low ≤ 1` and `med = high = 0`; no threshold-update txs. |
| **Detect classic trustlines / non-native balances** | **Read-only check** | Same — no `ChangeTrust` / balance-zeroing flows. |
| **Detect account `data` entries** | **Read-only check** | Same — no `ManageData` removal. |
| **Detect open SDEX offers** | **Read-only check** | API uses Horizon offers endpoint (`services/api/src/horizon.ts`); no cancel-offer txs. |
| **Soroban SAC balances (native + trustline assets)** | **Partial scan** | API Soroban RPC reads SAC `Balance` ledger entries per Horizon asset list (`services/api/src/sorobanScan.ts`). Does not cover arbitrary custom Soroban-only assets with no classic trustline. |
| **Soroban token allowances (selected spenders)** | **Partial scan** | Simulates SAC `allowance` for contract IDs in `SOROBAN_ALLOWANCE_SPENDERS`; skipped if unset. Not a full allowance/authorization explorer. |
| **Horizon + Soroban RPC read path** | **Yes** | Network toggle, optional `HORIZON_URL` / `SOROBAN_RPC_URL` (`services/api/README.md`). |
| **UI: health checklist** | **Yes** | `apps/web/src/App.tsx` — pass/fail/unknown/skipped rows for scans the tool performs. |
| **Non-custodial server (secrets)** | **Yes (so far)** | API only reads public Horizon/RPC; **no** secret submission endpoint. **Client-side signing is not built yet**, so the “full non-custodial product” is incomplete. |

### Not implemented (production gaps)

| Requirement | Status | Notes |
|-------------|--------|--------|
| **Remove sponsorships** | **No** | No transaction builder or signing. |
| **Remove extra signers / fix thresholds for self-service ops** | **No** | Detection only. |
| **Remove trustlines** | **No** | Detection only. |
| **Remove data entries** | **No** | Detection only. |
| **Claim selected claimable balances** | **No** | Not scanned or claimed. |
| **Close AMM / LP stakes** | **No** | Not scanned or closed. |
| **Close DeFi positions (Blend, Aquarius, Soroswap, …)** | **No** | Checklist row `defi_positions` is explicitly **unknown / not scanned**; no protocol adapters. |
| **Sell/rout all tokens (classic + Soroban) to a base asset** | **No** | No DEX/router integration or txs. |
| **Option: send non-XLM remainder to third-party wallet/exchange** | **No** | No payout routing UX or txs beyond merge messaging. |
| **Merge to destination + mediator pattern for CEX** | **No** | UI has a disabled “Demolish” placeholder; no `ACCOUNT_MERGE`, no temp mediator account flow. |
| **Dedicated “inspect only” mode for allowances + authorizations** | **No** | Allowance data appears inside the health JSON/checklist when configured; no separate read-only product mode or full authz surface (e.g. all Soroban auth entries). |
| **Soroban full parity with classic** | **No** | SAC-focused reads only; no general contract position discovery, Wasm token types beyond SAC pattern, etc. |
| **Stellar Wallets Kit in UI** | **No** | Dependency present (`@creit.tech/stellar-wallets-kit`); **not integrated** in `App.tsx` (buttons still “coming next”). |
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
