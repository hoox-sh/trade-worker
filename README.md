# HOOX · Trade Worker

**Multi-exchange execution engine — consumes signals, routes orders, logs every tick. The only isolate that touches exchange TLS.**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Part of the [HOOX](https://github.com/hoox-sh/hoox) edge-trading mesh — a production-grade algorithmic trading framework on Cloudflare Workers.**  
**Site:** [hoox.sh](https://hoox.sh) · **Docs:** [docs.hoox.sh](https://docs.hoox.sh) · **Paper:** [`hoox-arxiv-paper-core.pdf`](https://github.com/hoox-sh/hoox/blob/main/papers/hoox-arxiv-paper-core.pdf)

---

The execution plane. The trade-worker consumes from the `trade-execution` queue (backed by Cloudflare Queues with at-least-once delivery) and dispatches signed REST orders to Binance, Bybit, and MEXC — all three supported as first-class exchange targets. Each order is wrapped in an exponential-backoff retry loop (up to 5 attempts, jittered) with dead-letter escalation to R2 for forensic replay.

Post-execution, the worker logs structured trade records to D1 (via the [`d1-worker`](https://github.com/hoox-sh/d1-worker) service binding), offloads verbose byte-level logs to R2 (`hoox-system-logs`), fires telemetry events to the [`analytics-worker`](https://github.com/hoox-sh/analytics-worker), and pushes human-readable confirmations through the [`telegram-worker`](https://github.com/hoox-sh/telegram-worker). It is the only isolate in the mesh that holds exchange API credentials at runtime.

### Role in the Mesh

```
  hoox (Gateway)
       │
  ┌────┴────┐        trade-execution Queue
  │ Queue   │◄─────── (async decoupling)
  └────┬────┘
       │
       ▼
┌────────────────┐
│ trade-worker   │  ← execution (private, Smart Placement)
└────┬───────┬───┘
     │       │
     ▼       ▼
  Exchanges  R2 (logs)
  (Binance,  │
   Bybit,    ├──► d1-worker (trades, positions)
   MEXC)     ├──► analytics-worker (telemetry)
             └──► telegram-worker (confirmations)
```

### Service Bindings

| Target Worker                             | Binding             | Protocol                   |
| ----------------------------------------- | ------------------- | -------------------------- |
| [`d1-worker`](https://github.com/hoox-sh/d1-worker)               | `D1_SERVICE`        | Trade/position persistence |
| [`telegram-worker`](https://github.com/hoox-sh/telegram-worker)   | `TELEGRAM_SERVICE`  | Execution notifications    |
| [`analytics-worker`](https://github.com/hoox-sh/analytics-worker) | `ANALYTICS_SERVICE` | Performance telemetry      |

### Entry Points

| Method  | Path              | Auth         | Description                               |
| ------- | ----------------- | ------------ | ----------------------------------------- |
| `QUEUE` | `trade-execution` | Internal     | Queue consumer (primary)                  |
| `POST`  | `/webhook`        | Internal key | Direct signal injection (service binding) |
| `POST`  | `/process`        | Internal key | Legacy signal processing                  |
| `GET`   | `/api/signals`    | Internal key | Signal history                            |
| `GET`   | `/report`         | Internal key | Per-trade R2 report                       |
| `GET`   | `/health`         | None         | Liveness probe                            |

### Exchange Support

| Exchange | REST API            | Auth Method                  | Rate Limit   | Test trading (`test: true`)       |
| -------- | ------------------- | ---------------------------- | ------------ | --------------------------------- |
| Binance  | `fapi.binance.com`  | `X-MBX-APIKEY` + HMAC-SHA256 | 1200 req/min | Yes → `testnet.binancefuture.com` |
| Bybit    | `api.bybit.com`     | `API-Key` + HMAC-SHA256      | 50 req/s     | Yes → `api-testnet.bybit.com`     |
| MEXC     | `contract.mexc.com` | `ApiKey` + HMAC-SHA256       | 20 req/s     | No (no public REST sandbox)       |

### Test trading

Set `"test": true` on the webhook/queue JSON payload to route to the exchange testnet when supported. Live trading is the default.

| Concern | Behavior |
| ------- | -------- |
| Credentials | Prefer `BINANCE_TESTNET_*` / `BYBIT_TESTNET_*`; fall back to live keys with a warn log |
| Transport | Always REST testnet — live WebSocket DO is skipped |
| D1 | Status `TEST_EXECUTED`; position id `{exchange}-testnet-{symbol}-{side}` |
| Telegram | Exchange label includes `[TEST]` (no queue double-notify on success) |
| Analytics | Exchange blob `{exchange}:test` |
| Agent | Skips `*-testnet-*` OPEN rows |
| Dashboard | Positions filter Live/Testnet; **TEST** badge; close sends `test: true` |

Docs: [Test Trading](https://docs.hoox.sh/enduser/guides/test-trading) (or `docs/enduser/guides/test-trading.mdx` in-repo).

### Development

```bash
bun test workers/trade-worker
```

### Mesh interconnect

| Direction | Peers |
| --------- | ----- |
| **Called by** | [hoox-worker](https://github.com/hoox-sh/hoox-worker) (gateway / queue), [agent-worker](https://github.com/hoox-sh/agent-worker) (risk closes / stop adjustments), [email-worker](https://github.com/hoox-sh/email-worker) (parsed email signals). |
| **This worker calls** | See list below |

- **[d1-worker](https://github.com/hoox-sh/d1-worker)** — D1_SERVICE — trades, positions, audit rows
- **[telegram-worker](https://github.com/hoox-sh/telegram-worker)** — TELEGRAM_SERVICE — fill confirmations
- **[analytics-worker](https://github.com/hoox-sh/analytics-worker)** — ANALYTICS_SERVICE — execution telemetry

Full mesh (all isolates live as git submodules under [`hoox-sh/hoox`](https://github.com/hoox-sh/hoox) `workers/`):

| Isolate | Role | Repository |
| ------- | ---- | ---------- |
| [hoox-worker](https://github.com/hoox-sh/hoox-worker) | Public webhook gateway (WAF, idempotency, dispatch) | monorepo `workers/hoox-worker` |
| [trade-worker](https://github.com/hoox-sh/trade-worker) | Multi-exchange order execution (Binance / Bybit / MEXC) | monorepo `workers/trade-worker` |
| [agent-worker](https://github.com/hoox-sh/agent-worker) | AI risk manager (configurable cron 1–1440 min, kill switch) | monorepo `workers/agent-worker` |
| [d1-worker](https://github.com/hoox-sh/d1-worker) | D1 SQL proxy + settings / balances / positions | monorepo `workers/d1-worker` |
| [telegram-worker](https://github.com/hoox-sh/telegram-worker) | Alerts, bot commands, RAG copilot | monorepo `workers/telegram-worker` |
| [email-worker](https://github.com/hoox-sh/email-worker) | Mailgun / email signal parsing → trade | monorepo `workers/email-worker` |
| [analytics-worker](https://github.com/hoox-sh/analytics-worker) | Analytics Engine write + query path | monorepo `workers/analytics-worker` |
| [report-worker](https://github.com/hoox-sh/report-worker) | PDF reports via Browser Rendering → R2 | monorepo `workers/report-worker` |
| [web3-wallet-worker](https://github.com/hoox-sh/web3-wallet-worker) | On-chain wallet identity (ethers.js) | monorepo `workers/web3-wallet-worker` |
| [dashboard](https://github.com/hoox-sh/hoox/tree/main/workers/dashboard) | Next.js ops console (OpenNext, public) | monorepo `workers/dashboard` |

### Docs & monorepo

| Resource | Link |
| -------- | ---- |
| Isolate profile (operators) | [https://docs.hoox.sh/docs/devops/workers/trade-worker](https://docs.hoox.sh/docs/devops/workers/trade-worker) |
| Parent monorepo | [github.com/hoox-sh/hoox](https://github.com/hoox-sh/hoox) |
| This repository | [github.com/hoox-sh/trade-worker](https://github.com/hoox-sh/trade-worker) |
| Workers index | [docs.hoox.sh → Workers](https://docs.hoox.sh/docs/devops/workers) |
| CLI | `@hoox-sh/hoox-cli` · `hoox deploy worker trade-worker` |

### License

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — part of the HOOX open-core mesh.
