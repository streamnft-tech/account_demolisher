# Orbitway

Orbitway is an account health, cleanup, and safe-exit tool for Stellar accounts.
It helps users scan Stellar accounts, understand cleanup blockers, review account state, recover stuck value, and safely close or consolidate accounts through a non-custodial flow.
The current repository contains a working MVP for account inspection, health reporting, selected classic Stellar cleanup actions, wallet signing, and early Soroban / DeFi visibility.


## What Orbitway Does

Orbitway turns complex Stellar account state into a guided cleanup flow. Users can:

- scan a Stellar account without signing
- review balances, trustlines, offers, LP shares, sponsorships, signers, thresholds, data entries, claimable balances, Soroban balances, allowances, and selected DeFi state
- understand what blocks cleanup or `ACCOUNT_MERGE`
- follow an ordered cleanup path
- sign supported cleanup actions through a Stellar wallet
- prepare an account for safe close or consolidation

Orbitway is designed for users, wallets, explorers, exchanges, and ecosystem teams that need safer account cleanup and recovery infrastructure.

## Why It Matters

Stellar accounts accumulate state over time: trustlines, open DEX offers, AMM positions, claimable balances, data entries, sponsorships, extra signers, allowances, and protocol exposure. That makes cleanup and account closure difficult for users, wallets, exchanges, and support teams.

Orbitway gives a safer way to understand what is active in an account, what must be resolved, and which actions can already be handled through a wallet-signed flow.

## Architecture

Orbitway is structured as a workspace monorepo:

| Workspace | Path | Role |
| --- | --- | --- |
| `@stellar/web` | `apps/web` | Browser app for scanning accounts, showing blockers, connecting wallets, and signing supported transactions |
| `@stellar/api` | `services/api` | Fastify BFF for Horizon, Soroban RPC, and selected protocol reads |
| `@stellar/core` | `packages/core` | Shared types, health reports, blocker logic, and cleanup decision rules |

Design boundaries:

- network reads live in the API or wallet/browser layer
- domain rules live in `@stellar/core`
- UI state and signing flow live in `@stellar/web`
- private keys are never sent to the API

Repository layout:

```text
stellar/
├── apps/web/              # SPA - @stellar/web
├── services/api/          # Read-only BFF - @stellar/api
├── packages/core/         # Shared types and logic - @stellar/core
├── docs/
└── package.json           # workspace root
```

Important files:

| File | Purpose |
| --- | --- |
| `apps/web/src/App.tsx` | Main app UI, health workflow, blocker actions |
| `apps/web/src/walletKit.ts` | Wallet Kit initialization and signing helpers |
| `services/api/src/index.ts` | API routes and composition layer |
| `services/api/src/sorobanScan.ts` | SAC balance and allowance reads |
| `services/api/src/defiScan.ts` | Blend and selected DeFi read paths |
| `packages/core/src/health.ts` | Health checklist and blocker generation |

## Requirements

- Node.js 20+
- npm 10+

`pnpm` is not required. Any recent npm with workspace support is enough.

## Install

```bash
cd /Users/piyush/Desktop/work/stellar
npm install
```

This installs the root dependencies and all workspaces, including linking `@stellar/core` into the web and API apps.

## Local development

Run both apps together:

```bash
npm run dev:all
```

Other useful root scripts:

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite SPA only on port `5173` |
| `npm run dev:api` | Start the Fastify API only on port `8787` |
| `npm run build` | Run `build` in each workspace that defines it |
| `npm run typecheck` | Run `typecheck` in each workspace that defines it |

Default local ports:

| Service | Port | Notes |
| --- | --- | --- |
| SPA | `5173` | Vite dev server |
| API | `8787` | Fastify server |

The SPA proxies `/api` requests to the local API. If you run only `npm run dev`, any feature that depends on `/api` will fail unless the API is running separately.

## Networks

Health checks use Horizon for the network selected in the UI:

- Testnet -> `https://horizon-testnet.stellar.org`
- Mainnet -> `https://horizon.stellar.org`

If `HORIZON_URL` is set, that override is used for all Horizon-backed requests.

Soroban reads use these defaults:

- Testnet -> `https://soroban-testnet.stellar.org`
- Mainnet -> `https://soroban-rpc.mainnet.stellar.gateway.fm`

If `SOROBAN_RPC_URL` is set, that override is used for both networks. The `soroban-rpc.mainnet.stellar.org` hostname is intentionally not used here because it does not reliably resolve.

## Environment

API variables:

| Variable | Purpose |
| --- | --- |
| `HORIZON_URL` | Override Horizon base URL |
| `SOROBAN_RPC_URL` | Override Soroban RPC base URL |
| `SOROBAN_ALLOWANCE_SPENDERS` | Comma-separated Soroban spender contract IDs checked for allowances |
| `SOROSWAP_BEARER_TOKEN` | Enables server-side Soroswap quote / swap-XDR flow |
| `SOROSWAP_API_BASE` | Override Soroswap API host |
| `HOST` / `PORT` | API bind address and port |
| `LOG_UPSTREAM` / `LOG_UPSTREAM_BODY` | Upstream logging controls |

Web variables:

| Variable | Purpose |
| --- | --- |
| `VITE_WALLETCONNECT_PROJECT_ID` | Enables WalletConnect in Stellar Wallets Kit |

See [services/api/README.md](/Users/piyush/Desktop/work/stellar/services/api/README.md) for API details.

## Stellar dependencies

- `@stellar/stellar-sdk` - classic Stellar transaction building, Horizon access, and selected Soroban RPC helpers
- `@creit.tech/stellar-wallets-kit` - wallet connection and client-side signing
- `@blend-capital/blend-sdk` - Blend protocol read path for DeFi exposure checks

## Product flow

Orbitway follows a scan-first, sign-later model:

1. User enters a Stellar account or connects a wallet.
2. Orbitway scans account state using Horizon, Soroban RPC, and supported integrations.
3. The app generates a health report and blocker list.
4. The user reviews balances, trustlines, offers, LP positions, allowances, and supported DeFi state.
5. Orbitway suggests an ordered cleanup path.
6. Supported actions are signed client-side through the user's wallet.
7. Account state is refreshed after each transaction.
8. Eligible accounts can proceed toward final close or merge.

## Current MVP status

The current implementation already covers account inspection, health reporting, selected cleanup actions, wallet signing, and early Soroban / DeFi visibility.

### Implemented today

| Requirement | Status | Notes |
| --- | --- | --- |
| Sponsorship detection | Read-only check | Detects `num_sponsoring` and blocks merge when the account sponsors other reserves |
| Revoke sponsored classic entries | Partial | Builds revoke batches for Horizon-discoverable sponsored entries; multiple passes may be required |
| Extra signer removal and threshold reset | Partial | Removes extra `ed25519` signers and applies merge-friendly thresholds |
| Zero-balance trustline removal | Partial | Uses `ChangeTrust` limit `0` in batches |
| Non-zero trustline teardown | Partial | Supports selected sell / payout / teardown flows, including SDEX and optional Soroswap-assisted paths |
| Data entry removal | Partial | Deletes `ManageData` entries in batches |
| Open offer cancellation | Partial | Cancels classic SDEX offers in batches |
| Liquidity pool withdrawal | Partial | Supports classic LP share withdrawal with user-signed transactions |
| Claimable balance claiming | Partial | Detects and claims supported inbound claimable balances |
| `ACCOUNT_MERGE` to existing destination | Partial | Supports standard merge when blockers are cleared |
| SDEX offers and LP health visibility | Yes | Included in `openPositions` and surfaced in the UI |
| Soroban SAC balance scan | Partial | Reads SAC balances for Horizon-known assets |
| Soroban allowance checks | Partial | Simulates allowance checks for configured spender contracts |
| Horizon + Soroban RPC read path | Yes | Network-aware with optional endpoint overrides |
| Wallet connection and signing | Partial | Powered by Stellar Wallets Kit |
| Non-custodial architecture | Yes | Secrets are not sent to the API |

### Production gaps

| Requirement | Status | Notes |
| --- | --- | --- |
| Guaranteed non-zero trustline exit when SDEX and Soroswap are unusable | Gap | No full classic routing / liquidation engine yet |
| Non-`ed25519` signer removal | Gap | Pre-authorized tx and `hash(x)` signer automation not implemented |
| DeFi unwind execution | Gap | No Blend, Aquarius, or Soroswap LP unwind builder yet |
| Full Soroban-only inventory discovery and liquidation | Gap | Current Soroban support is SAC-focused |
| Exchange / third-party destination routing | Partial | Supports payout to confirmed classic addresses, not full exchange workflows |
| Mediator-account merge flow | Gap | Plain merge only |
| Dedicated inspect-only allowance mode | Gap | No separate read-only product mode yet |
| Multi-wallet or multisig transaction assembly | Gap | Not implemented |
| Dry-run / preview transaction planning | Gap | No rolling simulation or staged preview flow yet |

## Planned scope

The next phase expands Orbitway toward production-grade cleanup and safe-exit infrastructure for Stellar. That includes:

- stronger sponsorship handling
- broader multisig and signer support
- fuller Soroban allowance and authorization coverage
- DeFi position detection plus unwind execution
- portfolio routing and liquidation planning
- exchange destination and memo/tag handling
- mediator-account flows
- dry-run and per-step transaction preview
- optional local-only secret input for advanced cases
- multi-wallet and multisig transaction assembly
- stronger edge-case coverage and integration documentation

## Dry-run approach

The practical dry-run model for Orbitway is a rolling, state-aware plan rather than one static preview:

1. build an ordered plan object from the latest Horizon and RPC snapshot
2. simulate each supported step against current account state
3. refresh account state after every signed transaction
4. recompute the remaining plan from the new state
5. block one-click demolition when unresolved state remains unknown

This matters because cleanup is inherently multi-transaction and each submitted transaction changes the account state for what comes next.

## Docs

- [Use cases and components](/Users/piyush/Desktop/work/stellar/docs/ORBITWAY_USECASES_AND_COMPONENTS.md)
- [Technical overview](/Users/piyush/Desktop/work/stellar/docs/TECHNICAL_OVERVIEW.md)

