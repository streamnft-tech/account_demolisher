# API service (@stellar/api)

## Networks: testnet vs mainnet

By default the API talks to **public SDF Horizon** for the network you pass per request:

| Query | Horizon base |
|-------|----------------|
| `?network=testnet` (default) | `https://horizon-testnet.stellar.org` |
| `?network=mainnet` or `?network=public` | `https://horizon.stellar.org` |

Example:

```http
GET /api/account/G.../health?network=mainnet
```

If **`HORIZON_URL`** is set in the environment, it **overrides** both: every request uses that base URL, and responses mark `ledgerNetwork: "custom"`.

Soroban scans use **public RPC** per `?network=` unless **`SOROBAN_RPC_URL`** is set (then that URL is used for both networks, same pattern as Horizon).

## Environment

| Variable | Description |
|----------|-------------|
| `HORIZON_URL` | Optional. If set, forces a single Horizon base for all requests (overrides `?network=`). No trailing slash. |
| `SOROBAN_RPC_URL` | Optional. If set, forces a single Soroban RPC base for all requests. |
| `SOROBAN_ALLOWANCE_SPENDERS` | Optional. Comma-separated **contract** addresses (`C…`) to query `allowance(from, spender)` on each Stellar Asset Contract we check. If unset, the checklist marks allowances as **skipped** (not a fail). |
| `PORT` | Default `8787` |
| `HOST` | Default `127.0.0.1` |
| `LOG_UPSTREAM` | Default **on** (any value except `0`). Set to **`0`** to silence structured logs of Horizon / Soroban responses the API proxies. |
| `LOG_UPSTREAM_BODY` | Set to **`1`** to also log response body previews (first ~4k chars) for Horizon account/offers and Soroban scan payloads — very noisy; use only while debugging. |

## Routes

- `GET /health` — liveness + which Horizon / Soroban RPC URLs are in effect  
- `GET /api/account/:accountId/health?network=testnet|mainnet` — classic + Soroban health / merge blockers (see `checklist` in JSON)  
