# Orbitway Technical Overview

This document describes the current implementation of the Orbitway monorepo: tech stack, local setup, runtime boundaries, and request/data flow. It should be read alongside [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md), which remains the visual reference for component interactions.

## 1. Purpose

Orbitway is a Stellar account inspection and cleanup application. The current repo implements:

- a React SPA for running account health checks and triggering selected classic cleanup actions
- a Fastify API that aggregates Horizon, Soroban RPC, and selected DeFi reads
- a shared TypeScript package containing health-report types and pure decision logic

The codebase is intentionally split so that:

- network I/O lives in the API or the browser wallet layer
- domain rules live in `@stellar/core`
- UI state and signing flow live in `@stellar/web`

## 2. Tech Stack

### Workspace layout

The repo uses npm workspaces declared in [package.json](../package.json).

| Workspace | Path | Role |
|---|---|---|
| `@stellar/web` | `apps/web` | Browser SPA for scanning accounts, showing blockers, connecting wallets, and signing supported cleanup transactions |
| `@stellar/api` | `services/api` | Read-oriented backend-for-frontend that talks to Horizon, Soroban RPC, and selected protocol SDKs |
| `@stellar/core` | `packages/core` | Shared types and pure health/blocker logic used by both web and API |

### Languages and tooling

| Area | Stack |
|---|---|
| Language | TypeScript across all workspaces |
| Package manager | npm workspaces |
| Node runtime | Node.js 20+ |
| Dev runner | `tsx watch` for the API, Vite for the SPA |
| Build tool | TypeScript compiler for `api` and `core`, Vite for `web` |

### Frontend

| Package | Use |
|---|---|
| `react` / `react-dom` | SPA rendering |
| `vite` | Dev server and web build |
| `@vitejs/plugin-react` | React integration for Vite |
| `@creit.tech/stellar-wallets-kit` | Wallet connection and transaction signing |
| `@stellar/stellar-sdk` | Classic Stellar transaction building and selected RPC helpers |

### Backend

| Package | Use |
|---|---|
| `fastify` | HTTP API server |
| `@fastify/cors` | CORS support for the API |
| `@stellar/stellar-sdk` | Horizon and Soroban RPC access, asset and transaction helpers |
| `@blend-capital/blend-sdk` | Blend protocol read path for DeFi exposure checks |

### Shared domain layer

`@stellar/core` exports:

- report types such as `HealthReport`, `Blocker`, `SorobanScanResult`
- pure health analysis helpers such as `buildHealthReport`
- position helpers such as liquidity-pool extraction and protocol-surface metadata

Key entrypoint: [packages/core/src/index.ts](../packages/core/src/index.ts)

## 3. Repository Structure

```text
stellar/
├── apps/
│   └── web/               # Vite + React SPA
├── services/
│   └── api/               # Fastify API
├── packages/
│   └── core/              # Shared report/types/helpers
├── docs/
│   ├── ARCHITECTURE_DIAGRAMS.md
│   ├── ORBITWAY_USECASES_AND_COMPONENTS.md
│   └── TECHNICAL_OVERVIEW.md
└── package.json
```

Important files:

- [apps/web/src/App.tsx](../apps/web/src/App.tsx): main app UI, health workflow, blocker actions
- [apps/web/src/walletKit.ts](../apps/web/src/walletKit.ts): wallet-kit initialization and signing helpers
- [services/api/src/index.ts](../services/api/src/index.ts): API routes and composition layer
- [services/api/src/sorobanScan.ts](../services/api/src/sorobanScan.ts): SAC balance and allowance checks
- [services/api/src/defiScan.ts](../services/api/src/defiScan.ts): Blend backstop read path
- [packages/core/src/health.ts](../packages/core/src/health.ts): canonical health checklist and blocker generation

## 4. Local Setup

### Requirements

- Node.js `20+`
- npm `10+`

### Install

```bash
cd /Users/piyush/Desktop/work/stellar
npm install
```

### Run locally

Start both the API and SPA:

```bash
npm run dev:all
```

Useful alternatives:

```bash
npm run dev       # web only, port 5173
npm run dev:api   # api only, port 8787
npm run build
npm run typecheck
```

### Default local ports

| Service | Port | Notes |
|---|---|---|
| SPA (`@stellar/web`) | `5173` | Vite dev server |
| API (`@stellar/api`) | `8787` | Fastify server |

The SPA proxies `/api` requests to the local API through [apps/web/vite.config.ts](../apps/web/vite.config.ts).

## 5. Environment Configuration

### API environment

Environment variables documented in [services/api/README.md](../services/api/README.md):

| Variable | Purpose |
|---|---|
| `HORIZON_URL` | Override Horizon base URL for all requests |
| `SOROBAN_RPC_URL` | Override Soroban RPC base URL for all requests |
| `SOROBAN_ALLOWANCE_SPENDERS` | Comma-separated Soroban spender contract IDs used for allowance checks |
| `SOROSWAP_BEARER_TOKEN` | Enables server-side Soroswap quote/build flow |
| `SOROSWAP_API_BASE` | Override Soroswap API host |
| `HOST` / `PORT` | API bind address and port |
| `LOG_UPSTREAM` / `LOG_UPSTREAM_BODY` | Upstream request/response logging controls |

### Web environment

Current web-specific environment use:

| Variable | Purpose |
|---|---|
| `VITE_WALLETCONNECT_PROJECT_ID` | Enables WalletConnect module in Stellar Wallets Kit |

## 6. Architecture

The high-level component diagram and request sequence already live in [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md). The practical architecture can be summarized as follows.

### Web layer

`@stellar/web` is a client-rendered SPA that:

- captures user input such as source account, network, and destination account
- calls API health endpoints
- renders grouped checklist rows and blockers from `HealthReport`
- builds or requests XDRs for supported classic cleanup flows
- uses Stellar Wallets Kit for client-side signing

The web app does not hold server secrets and does not proxy signing through the API.

### API layer

`@stellar/api` is a thin composition layer. It does not custody user keys. It is responsible for:

- validating request shape
- reading classic account state from Horizon
- reading Soroban state from RPC
- reading selected DeFi protocol state, currently Blend
- composing those slices into a normalized `HealthReport`

The API is not a generic planner or execution engine. It is currently a read-oriented BFF plus a small number of helper routes such as order-book lookup and Soroswap quote/build.

### Shared domain layer

`@stellar/core` defines the canonical health model. This is where the codebase decides:

- which checklist rows exist
- which conditions block account demolition
- how open positions are represented
- how classic, Soroban, and DeFi findings collapse into blocker codes

This separation keeps business logic testable and avoids duplicating rules between API and UI.

## 7. External Dependencies and Network Boundaries

### Horizon

Horizon is used for classic Stellar reads:

- account JSON
- trustline and balance inspection
- SDEX offers
- claimable balances
- classic liquidity-pool balances
- destination-account existence checks

Default endpoints are network-specific unless `HORIZON_URL` is set.

### Soroban RPC

Soroban RPC is used for:

- Stellar Asset Contract balance checks
- SAC allowance checks against configured spender contracts
- protocol-backed reads such as Blend through SDK + RPC

Default endpoints are network-specific unless `SOROBAN_RPC_URL` is set.

### Protocol integrations

Current protocol-specific integration:

- Blend via `@blend-capital/blend-sdk` for reward-zone/backstop exposure checks

Current non-integrated-but-documented surfaces:

- Aquarius
- Soroswap positions and unwind flows beyond the existing quote/build helper

## 8. Request and Data Flow

### Primary health-check flow

At a high level:

1. The SPA sends `GET /api/account/:accountId/health?network=...`.
2. The API fetches Horizon account state and classic positions.
3. In parallel, the API runs Soroban SAC checks and DeFi surface checks.
4. The API calls `buildHealthReport` from `@stellar/core`.
5. The SPA renders `checklist`, `blockers`, `summary`, and `openPositions`.

See the sequence diagram in [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md#2-sequence-diagram--user-journey-current-spa).

### Supporting routes

Additional API routes serve focused read paths or helper flows:

| Route | Purpose |
|---|---|
| `GET /api/account/:accountId/horizon` | Raw Horizon account payload for debugging/advanced flows |
| `GET /api/account/:accountId/offers` | Full classic SDEX offers for cancel flows |
| `GET /api/account/:accountId/claimable-balances` | Inbound claimable balance IDs |
| `GET /api/order-book` | Classic credit-to-native order book lookup |
| `GET /api/soroswap/status` | Whether Soroswap helper is configured |
| `POST /api/soroswap/swap-xdr` | Build Soroswap swap XDR through server-side bearer auth |

## 9. Transaction and Signing Model

Current write flow is intentionally non-custodial:

- XDRs are constructed in the client for supported classic operations
- user signatures are gathered through Stellar Wallets Kit
- the API does not receive user secret keys
- the API may use server-side credentials only for third-party service access such as Soroswap quote/build

Implemented classic write helpers include:

- remove data entries
- cancel SDEX offers
- withdraw LP shares
- claim inbound claimable balances
- remove empty trustlines
- remove extra `ed25519_public_key` signers
- set merge-friendly thresholds
- perform plain `ACCOUNT_MERGE` to an existing destination account

## 10. Current Limitations

The repo is not yet a full demolition planner/executor. The main technical gaps are:

- no mediator-account merge flow for exchanges/CEX destinations
- no full multisig signing workflow across multiple keys or wallets
- no general Soroban teardown parity
- no DeFi unwind transaction builders for Blend, Aquarius, or Soroswap LP positions
- no dry-run planner or sequential execution session model
- no automatic discovery of arbitrary Soroban-only assets or all active spender authorizations

These limits are described in more detail in:

- [README.md](../README.md)
- [ORBITWAY_USECASES_AND_COMPONENTS.md](./ORBITWAY_USECASES_AND_COMPONENTS.md)

## 11. Development Notes

When extending the codebase, keep these boundaries intact:

- add network reads to `services/api`
- keep report and blocker decisions in `packages/core`
- keep signing and interactive execution in `apps/web`

That separation matches the current implementation and the diagrams in [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md), and it is the cleanest path for future additions such as a planner, preview engine, or deeper Soroban protocol adapters.
