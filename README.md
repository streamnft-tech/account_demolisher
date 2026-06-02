# Orbitway

Orbitway is an account health, cleanup, and safe-exit tool for Stellar accounts.
It helps users scan Stellar accounts, understand cleanup blockers, review account state, recover stuck value, and safely close or consolidate accounts through a non-custodial flow.

The current repository contains a working MVP for account inspection, health reporting, selected classic Stellar cleanup actions, wallet signing, and early Soroban / DeFi visibility.

## What Orbitway Does

Orbitway turns complex Stellar account state into a guided cleanup flow.

Users can:

- scan a Stellar account without signing
- view balances, trustlines, open offers, LP shares, data entries, claimable balances, sponsorships, signers, thresholds, Soroban balances, allowances, and selected DeFi state
- understand what blocks cleanup or account merge
- generate an ordered cleanup plan
- sign supported cleanup actions through a Stellar wallet
- prepare for safe account close or merge where eligible

Orbitway is designed for users, wallets, explorers, exchanges, and ecosystem teams that need safer account cleanup and recovery infrastructure.

## Why It Matters

Stellar accounts can accumulate state over time: trustlines, open DEX offers, AMM / LP positions, claimable balances, data entries, sponsorships, extra signers, allowances, and DeFi positions.

This makes account cleanup difficult for users and support teams. A user may want to close or consolidate an account, but the account may still have unresolved state that blocks account merge or puts funds at risk.

Orbitway gives users a safer way to understand what is active in an account, what needs cleanup, and what must be resolved before an account can be closed.

## Current MVP Status

The current MVP includes:

- React SPA for account scan and health reports
- Fastify API for Horizon, Soroban RPC, and selected DeFi reads
- shared TypeScript core package for health reports and blocker logic
- Stellar Wallets Kit integration for wallet connection and signing
- classic account reads through Horizon
- selected classic cleanup helpers
- Blend backstop exposure visibility
- standard `ACCOUNT_MERGE` to an existing destination account

The MVP is currently focused on account inspection, cleanup readiness, and selected classic cleanup execution.

Production-grade Soroban parity, DeFi unwind execution, mediator-account flow, advanced multisig signing, full portfolio liquidation, and dry-run planning are part of the planned scope.

## Planned RFP Scope

The next phase of Orbitway expands the MVP into production-ready account cleanup and safe-exit infrastructure for Stellar.

Planned scope includes:

- sponsorship detection and revoke handling
- multisig signer removal and threshold adjustment
- Soroban SAC balance scanning
- Soroban allowance inspection and revocation where supported
- inspect-only mode for allowances without account demolition
- SAC token routing and conversion planning
- DeFi position detection
- supported DeFi unwind execution
- portfolio liquidation into XLM and supported target assets
- wallet and exchange destination planning
- memo and tag handling for exchange destinations
- mediator-account flow for destinations that cannot receive `ACCOUNT_MERGE`
- step-by-step dry-run and transaction preview flow
- optional local-only direct secret key input for advanced or legacy accounts
- multi-wallet and multisig transaction assembly
- edge-case test suite
- open-source documentation and integration support

## Product Flow

Orbitway follows a scan-first, sign-later model.

1. User enters a Stellar account address or connects a wallet.
2. Orbitway scans account state using Horizon, Soroban RPC, and supported integrations.
3. The system generates an account health report.
4. User reviews blockers, balances, trustlines, offers, LP positions, allowances, and supported DeFi state.
5. Orbitway generates an ordered cleanup plan.
6. User reviews cleanup actions before signing.
7. Supported actions are signed client-side through the user's wallet.
8. Account state is refreshed after each transaction.
9. Eligible accounts can proceed toward final close or merge.

## Architecture Overview

Orbitway is structured as a modular monorepo with three main workspaces.

| Workspace | Path | Role |
| --- | --- | --- |
| `@stellar/web` | `apps/web` | Browser SPA for scanning accounts, showing blockers, connecting wallets, and signing supported cleanup transactions |
| `@stellar/api` | `services/api` | Fastify backend-for-frontend that reads Horizon, Soroban RPC, and selected protocol data |
| `@stellar/core` | `packages/core` | Shared TypeScript types, health reports, blocker logic, and cleanup decision rules |

The codebase is intentionally split so that:

- network reads live in the API or browser wallet layer
- domain rules live in `@stellar/core`
- UI state and signing flow live in `@stellar/web`
- private keys are never sent to the API

For diagrams, see:

- [docs/ARCHITECTURE_DIAGRAMS.md](docs/ARCHITECTURE_DIAGRAMS.md)
- [docs/TECHNICAL_OVERVIEW.md](docs/TECHNICAL_OVERVIEW.md)

## Tech Stack

| Area | Stack |
| --- | --- |
| Language | TypeScript |
| Package manager | npm workspaces |
| Node runtime | Node.js 20+ |
| Frontend | React + Vite |
| Backend | Fastify |
| Shared logic | TypeScript package in `packages/core` |

### Stellar and Protocol Dependencies

| Package | Use |
| --- | --- |
| `@stellar/stellar-sdk` | Classic Stellar transaction building, Horizon access, and selected Soroban RPC helpers |
| `@creit.tech/stellar-wallets-kit` | Wallet connection and client-side transaction signing |
| `@blend-capital/blend-sdk` | Blend protocol read path for DeFi exposure checks |

## Repository Structure

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
├── package.json
└── tsconfig.base.json
```

### Important Files

| File | Purpose |
| --- | --- |
| [apps/web/src/App.tsx](apps/web/src/App.tsx) | Main app UI, health workflow, blocker actions |
| [apps/web/src/walletKit.ts](apps/web/src/walletKit.ts) | Wallet Kit initialization and signing helpers |
| [services/api/src/index.ts](services/api/src/index.ts) | API routes and composition layer |
| [services/api/src/sorobanScan.ts](services/api/src/sorobanScan.ts) | SAC balance and allowance checks |
| [services/api/src/defiScan.ts](services/api/src/defiScan.ts) | Blend backstop read path |
| [packages/core/src/health.ts](packages/core/src/health.ts) | Health checklist and blocker generation |

## Local Setup

### Requirements

- Node.js 20+
- npm 10+

### Install

```bash
npm install
```

### Run Locally

Start both the API and SPA:

```bash
npm run dev:all
```

Useful alternatives:

- `npm run dev`
- `npm run dev:api`
- `npm run build`
- `npm run typecheck`

### Default Local Ports

| Service | Port | Notes |
| --- | --- | --- |
| SPA | `5173` | Vite dev server |
| API | `8787` | Fastify server |

The SPA proxies `/api` requests to the local API through `apps/web/vite.config.ts`.

## Environment Configuration

### API environment

| Variable | Purpose |
| --- | --- |
| `HORIZON_URL` | Override Horizon base URL for all requests |
| `SOROBAN_RPC_URL` | Override Soroban RPC base URL for all requests |
| `SOROBAN_ALLOWANCE_SPENDERS` | Comma-separated Soroban spender contract IDs used for allowance checks |
| `SOROSWAP_BEARER_TOKEN` | Enables server-side Soroswap quote/build flow |
| `SOROSWAP_API_BASE` | Override Soroswap API host |
| `HOST` / `PORT` | API bind address and port |
| `LOG_UPSTREAM` / `LOG_UPSTREAM_BODY` | Upstream request and response logging controls |

### Web environment

| Variable | Purpose |
| --- | --- |
| `VITE_WALLETCONNECT_PROJECT_ID` | Enables WalletConnect module in Stellar Wallets Kit |

## Current Capabilities

The current implementation supports account health checks and selected classic cleanup flows.

| Capability | Status | Notes |
| --- | --- | --- |
| Detect sponsorships | Partial | Detects sponsorship-related state such as `num_sponsoring` |
| Revoke sponsorships | Partial | Builds revoke operations for Horizon-discoverable sponsored entries where safe. Large accounts may require multiple passes |
| Detect multisig / extra signers | Partial | Detects extra signers and threshold mismatches |
| Remove extra `ed25519` signers | Partial | Supports selected signer removal where authority permits. Non-`ed25519` signer types are not fully automated |
| Set merge-friendly thresholds | Partial | Supports selected threshold adjustments where authority permits |
| Remove zero-balance trustlines | Partial | Uses `ChangeTrust(0)` for qualifying classic trustlines |
| Handle non-zero trustlines | Partial | Supports selected sell, payout, and teardown paths, but not full portfolio routing yet |
| Remove data entries | Partial | Deletes `ManageData` entries in batches |
| Cancel SDEX offers | Partial | Fetches and cancels classic offers where supported |
| Withdraw classic LP shares | Partial | Supports classic liquidity pool share withdrawal paths |
| Claim inbound claimable balances | Partial | Detects and claims supported inbound claimable balances |
| Standard `ACCOUNT_MERGE` | Partial | Supports plain merge to an existing destination account |
| SAC balance scanning | Partial | Detects SAC balances for known assets |
| Soroban allowance checks | Partial | Checks configured spender contracts where provided |
| Blend backstop visibility | Partial | Provides read-only exposure visibility |
| Stellar Wallets Kit | Partial | Supports wallet connection and signing |
| Non-custodial API model | Yes | API does not receive user private keys |

## Known Gaps / Roadmap

The repository is not yet a full production demolition planner or executor.

Known gaps include:

- no full mediator-account flow for exchange or CEX destinations
- no complete multisig signing workflow across multiple keys or wallets
- no full Soroban teardown parity
- no full allowance and authorization explorer
- no DeFi unwind transaction builders for Blend, Aquarius, Soroswap, or other protocol LP positions
- no full portfolio liquidation engine
- no generic best-route engine across all supported liquidity sources
- no full non-XLM target-asset routing
- no automatic discovery of arbitrary Soroban-only assets
- no full dry-run planner or sequential execution session model
- no complete production UX for all irreversible cleanup and close flows

These items are part of the planned RFP scope and will be implemented progressively.

## Safety Model

Orbitway is designed to be non-custodial and conservative by default.

Current and planned safety principles:

- scanning does not require signing
- users review cleanup actions before signing
- transactions are signed client-side through supported wallets
- private keys are never sent to the backend
- the API does not custody funds
- server-side credentials, where used, are only for third-party service access such as Soroswap quote and build APIs
- unsupported or unverifiable account state blocks account merge
- account merge is treated as a final irreversible action
- account state should be refreshed after each cleanup transaction

Planned production safety features include:

- step-by-step transaction preview
- dry-run and simulation checks where supported
- slippage warnings for swaps
- destination and memo review
- typed confirmations for irreversible actions
- failed transaction recovery guidance
- stale plan invalidation after account-state changes

## Dry-Run / Preview Approach

Full account demolition is multi-transaction and state-dependent. Each transaction can change what the next valid action should be.

Orbitway's planned dry-run model is rolling and step-based:

1. Build a cleanup plan from the latest Horizon or Soroban snapshot.
2. Show the user each planned action, dependency, risk, expected state change, and estimated transaction count.
3. Run Horizon preconditions and Soroban simulation where supported.
4. Ask the user to sign only the current step.
5. Submit the transaction.
6. Refresh account state.
7. Recompute the remaining cleanup plan.
8. Continue until the account is ready for final close or merge, or an unsupported blocker remains.

The final account merge step should include a preview of expected destination balance, residual risks, and irreversible-action warnings.

## Documentation

Relevant project documentation:

- [docs/TECHNICAL_OVERVIEW.md](docs/TECHNICAL_OVERVIEW.md)
- [docs/ARCHITECTURE_DIAGRAMS.md](docs/ARCHITECTURE_DIAGRAMS.md)
- [docs/ORBITWAY_USECASES_AND_COMPONENTS.md](docs/ORBITWAY_USECASES_AND_COMPONENTS.md)

## License

Orbitway is released under the Apache License 2.0.

We chose Apache-2.0 because it is a permissive open-source license suitable for infrastructure, wallet tooling, protocol integrations, and ecosystem adoption. It allows users, developers, wallets, explorers, exchanges, and protocol teams to use, modify, distribute, and integrate Orbitway while preserving copyright notices and license terms.

See the [LICENSE](LICENSE) file for details.

## Contributing

Contribution guidance will be added as the project moves toward production readiness.

Planned contribution materials include:

- local setup instructions
- architecture notes
- self-hosting guide
- integration notes for wallets, explorers, exchanges, and protocol teams
- issue templates for unsupported account states
- security reporting process
