# Orbitway — architecture diagrams

Diagrams reflect the **monorepo layout** ([README.md](../README.md)), **API** ([services/api/README.md](../services/api/README.md)), **product scope** ([ORBITWAY_USECASES_AND_COMPONENTS.md](./ORBITWAY_USECASES_AND_COMPONENTS.md)), and **current code** in `apps/web`, `services/api`, and `packages/core`.

**Note:** The root README “production requirements” table may lag the codebase (e.g. DeFi: `scanDefiProtocols` runs on `GET .../health`). These diagrams follow the **implemented** health path unless labeled as planned.

---

## 1. High-level components and interactions

Internal packages, external Stellar services, and documented-but-not-yet-wired pieces.

```mermaid
flowchart TB
  subgraph User["User / browser"]
    U[Operator]
  end

  subgraph DevHost["Developer machine"]
    subgraph Web["@stellar/web — Vite SPA :5173"]
      UI[App.tsx — checklist, destination, Orbitway workspace]
      WK[Stellar Wallets Kit — connect / profile / sign hook]
      CoreC["@stellar/core — types, isValidClassicAddress"]
    end
    subgraph API["@stellar/api — Fastify :8787"]
      IDX[index.ts — routes + CORS]
      HZ[horizon.ts — account, offers flags]
      FC[fetchClassicPositions.ts — SDEX offers]
      SB[sorobanScan.ts — SAC balances, allowances]
      DF[defiScan.ts — Blend SDK → RPC]
      CORE[buildHealthReport — @stellar/core]
    end
    PROXY[Vite proxy `/api` → 8787]
  end

  subgraph Ext["External Stellar network"]
    H[(Horizon — classic REST)]
    R[(Soroban RPC — getLedgerEntries / reads)]
    BC[(Blend contracts on ledger — via RPC)]
  end

  subgraph Deps["NPM libraries (in-process)"]
    SKD["@stellar/stellar-sdk"]
    BLEND["@blend-capital/blend-sdk"]
  end

  subgraph Planned["Documented / README — not fully wired"]
    PL[Planner / preview / automated tx execution]
    POS["Handbook position API — not in repo"]
  end

  U --> UI
  UI --> WK
  UI --> CoreC
  UI -->|HTTP GET `/api/.../health`| PROXY
  PROXY --> IDX

  IDX --> HZ --> H
  IDX --> FC --> H
  IDX --> SB --> R
  IDX --> SB --> SKD
  IDX --> DF --> BLEND --> R
  IDX --> DF --> BC
  IDX --> CORE

  UI -.->|future| PL
  IDX -.->|RFP / docs| POS
```

### Legend

- **Solid arrows:** implemented request/data flow for the current vertical slice.
- **Dashed arrows:** described in docs or README as future work (planner, external position API, automated signed teardown).

---

## 2. Sequence diagram — user journey (current SPA)

Default flow: network + optional wallet connect + source G-address (+ optional destination) → **read-only** `GET .../health` → checklist. Demolish / merge / per-blocker signed fixes remain future work.

```mermaid
sequenceDiagram
  autonumber
  actor User as User
  participant Browser as Browser (SPA)
  participant Vite as Vite dev server :5173
  participant API as Fastify API :8787
  participant Core as @stellar/core
  participant Horizon as Horizon (classic)
  participant RPC as Soroban RPC
  participant Blend as Blend on-ledger (via SDK/RPC)

  User->>Browser: Open app, choose Testnet/Mainnet
  User->>Browser: Enter source G-address (and optional destination)
  User->>Browser: Click "Run health check"

  Browser->>Vite: GET /api/account/{G}/health?network=...
  Note over Vite,API: Dev: Vite proxies `/api` → 8787. Production: serve SPA + call API same-origin or configured base URL.
  Vite->>API: Forward request

  API->>API: Validate classic address
  par Classic presence + offer hint
    API->>Horizon: Fetch account (404 → not found report)
    API->>Horizon: Check open offers (count / existence)
  end

  alt Account missing on Horizon
    API->>Core: buildHealthReport (no account, minimal Soroban stub)
    Core-->>API: HealthReport JSON
    API-->>Browser: 200 + report
    Browser-->>User: Checklist: account not found / wrong network
  else Account exists
    par Soroban SAC scan and DeFi scan
      API->>RPC: Read SAC / contract state (sorobanScan)
      API->>Blend: Backstop / pool user reads (defiScan + Blend SDK → RPC)
    end
    API->>Core: buildHealthReport(account, offersCount, soroban, openPositions.defiProtocols)
    Core-->>API: HealthReport (checklist, blockers, openPositions, summary)
    API-->>Browser: 200 + JSON
    Browser-->>User: Show checklist, Horizon/Soroban URLs, blockers, canDemolish
  end

  User->>Browser: Optionally enter destination, read "Demolish" copy
```

### Other API routes (not shown in the sequence above)

The API also exposes split endpoints for progressive or alternate clients:

- `GET /api/account/:accountId/horizon`
- `GET /api/account/:accountId/offers`
- `POST /api/account/:accountId/soroban-scan` (body: `horizonAccount`)

The current `App.tsx` health flow uses the monolithic **`GET /api/account/:accountId/health`** only.

---

## Rendering

- **GitHub / GitLab:** native Mermaid in markdown.
- **VS Code / Cursor:** Mermaid preview extensions, or paste into [mermaid.live](https://mermaid.live) for PNG/SVG export.
