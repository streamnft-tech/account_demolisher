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

Soroban scans use **public RPC** per `?network=` unless **`SOROBAN_RPC_URL`** is set (then that URL is used for both networks, same pattern as Horizon). **Mainnet default** is Gateway’s public endpoint (`soroban-rpc.mainnet.stellar.gateway.fm`); the older `soroban-rpc.mainnet.stellar.org` host does not resolve in DNS. Override with `SOROBAN_RPC_URL` if you use another provider.

## Environment

| Variable | Description |
|----------|-------------|
| `HORIZON_URL` | Optional. If set, forces a single Horizon base for all requests (overrides `?network=`). No trailing slash. |
| `SOROBAN_RPC_URL` | Optional. If set, forces a single Soroban RPC base for all requests. |
| `SOROBAN_ALLOWANCE_SPENDERS` | Optional. Comma-separated **contract** addresses (`C…`) to query `allowance(from, spender)` on each Stellar Asset Contract we check. If unset, the checklist marks allowances as **skipped** (not a fail). |
| `SOROSWAP_BEARER_TOKEN` | Optional. **JWT** from [Soroswap API](https://api.soroswap.finance/docs) (Bearer auth). Enables `GET /api/soroswap/status` → `configured: true` and `POST /api/soroswap/swap-xdr` for classic credit→native swap XDR used by the web trustline card. |
| `SOROSWAP_API_BASE` | Optional. Override Soroswap API host (default `https://api.soroswap.finance`). |
| `PORT` | Default `8787` |
| `HOST` | Default `127.0.0.1` |
| `LOG_UPSTREAM` | Default **on** (any value except `0`). Set to **`0`** to silence structured logs of Horizon / Soroban responses the API proxies. |
| `LOG_UPSTREAM_BODY` | Set to **`1`** to also log response body previews (first ~4k chars) for Horizon account/offers and Soroban scan payloads — very noisy; use only while debugging. |

## Routes

- `GET /health` — liveness + which Horizon / Soroban RPC URLs are in effect  
- `GET /api/account/:accountId/health?network=testnet|mainnet` — classic + Soroban health / merge blockers (see `checklist` in JSON). Populates **`openPositions.sdexOffers`** (paginated Horizon offers) and **`openPositions.liquidityPoolShares`** (from account balances).  
- `GET /api/order-book?network=…&asset_code=…&asset_issuer=G…` — Horizon SDEX **order book** for selling the credit asset vs **native** (used by the web trustline card; avoids browser CORS to Horizon)
- `GET /api/account/:accountId/horizon?network=` — raw Horizon account JSON (debug / advanced clients)  
- `GET /api/account/:accountId/offers?network=` — full SDEX offer rows for the account (used by web cancel flow)  
- `GET /api/account/:accountId/claimable-balances?network=` — inbound claimable balance IDs (`claimant` = account)  
- `GET /api/soroswap/status` — `{ configured: boolean }` (true when `SOROSWAP_BEARER_TOKEN` is set)  
- `POST /api/soroswap/swap-xdr?network=testnet|mainnet` — body `{ sourceAccount, assetCode, assetIssuer, sellAmount, slippageBps? }` → `{ xdr, quote }` for Soroswap quote+build (server-side Bearer; used by web trustline “Sell via Soroswap”)  
