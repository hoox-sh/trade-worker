/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exchange ↔ D1 position reconciliation.
 *
 * After fire-and-forget D1 writes (waitUntil), the ledger can lag or miss fills.
 * This module pulls live positions from each configured exchange and upserts D1
 * so agent risk + dashboard reflect exchange as source of truth.
 *
 * - Live credentials only (not testnet) unless options.testnet === true
 * - Closes D1 OPEN rows no longer present (or size≈0) on the exchange
 * - Upserts OPEN rows for non-zero exchange positions
 */

import {
  authenticatedServiceFetch,
  D1_READ_AUTH_KEY_FIELDS,
  D1_WRITE_AUTH_KEY_FIELDS,
  resolveInternalAuthKey,
} from "@hoox-sh/hoox-shared/service-bindings";
import { createLogger } from "@hoox-sh/hoox-shared/middleware";
import { toError } from "@hoox-sh/hoox-shared/errors";
import { factories } from "./exchange-router";
import type { Env } from "./exchange-router";
import type { IExchangeClient } from "./execution";
import {
  hasExchangeCredentials,
  resolveExchangeCredentials,
} from "./exchange-credentials";

const logger = createLogger({ service: "trade-worker", module: "reconcile" });

const SUPPORTED_EXCHANGES = ["binance", "bybit", "mexc"] as const;
export type ReconcileExchange = (typeof SUPPORTED_EXCHANGES)[number];

/** Max concurrent per-exchange position fetches / reconcile work. */
const RECONCILE_EXCHANGE_CONCURRENCY = 3;

/**
 * Map items with a bounded concurrency pool. Results keep input order.
 * Failures are not swallowed — callers should catch per-item if isolation is needed.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  const results = new Array<R>(n);
  let next = 0;
  const workers = Math.min(Math.max(1, concurrency), n);

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/** Canonical open position used for diffing. */
export interface CanonicalPosition {
  exchange: string;
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice?: number;
  unrealizedPnl?: number;
}

export interface D1OpenPositionRow {
  id: string;
  exchange: string;
  symbol: string;
  side: string;
  size: number | null;
  status: string;
}

export interface ExchangeReconcileResult {
  exchange: string;
  status: "ok" | "skipped" | "error";
  reason?: string;
  exchangeOpen: number;
  d1OpenBefore: number;
  upserted: number;
  closed: number;
  unchanged: number;
  errors: string[];
}

export interface ReconcileSummary {
  timestamp: string;
  testnet: boolean;
  exchanges: ExchangeReconcileResult[];
  totals: {
    upserted: number;
    closed: number;
    unchanged: number;
    errors: number;
  };
}

export interface ReconcileOptions {
  /** Limit to these exchanges (default: all with live credentials). */
  exchanges?: string[];
  /** When true, use testnet clients and testnet position ID namespace. */
  testnet?: boolean;
  /** Injected clients for tests (exchange name → client). */
  clients?: Partial<Record<string, IExchangeClient>>;
  /** Injected D1 open rows (skip D1 read). */
  d1OpenRows?: D1OpenPositionRow[];
  /** Dry-run: compute diffs without writing. */
  dryRun?: boolean;
}

const SIZE_EPS = 1e-10;

function positionId(
  exchange: string,
  symbol: string,
  side: "LONG" | "SHORT",
  testnet: boolean
): string {
  return testnet
    ? `${exchange}-testnet-${symbol}-${side}`
    : `${exchange}-${symbol}-${side}`;
}

/**
 * Normalize raw exchange API payloads into canonical non-zero positions.
 * Handles Binance positionRisk, Bybit v5 list wrappers, MEXC-ish rows, and
 * already-normalized Position objects from the shared type.
 */
export function normalizeExchangePositions(
  exchange: string,
  raw: unknown
): CanonicalPosition[] {
  const list = unwrapPositionList(raw);
  const out: CanonicalPosition[] = [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;

    const symbol = String(
      row.symbol ?? row.Symbol ?? row.contract ?? ""
    )
      .trim()
      .toUpperCase();
    if (!symbol) continue;

    // Size / amount — various exchange field names
    const sizeRaw =
      row.quantity ??
      row.size ??
      row.positionAmt ??
      row.position_amt ??
      row.holdVol ??
      row.vol ??
      row.qty;
    let size = toFiniteNumber(sizeRaw);
    if (size === null) continue;

    // Side — explicit or inferred from signed amount
    let side = parseSide(row.side ?? row.positionSide ?? row.position_side);
    if (!side) {
      if (size > 0) side = "LONG";
      else if (size < 0) side = "SHORT";
      else continue;
    }
    size = Math.abs(size);
    if (size <= SIZE_EPS) continue;

    const entryPrice = toFiniteNumber(
      row.entryPrice ?? row.entry_price ?? row.avgPrice ?? row.avg_price
    );
    const unrealizedPnl = toFiniteNumber(
      row.unrealizedPnl ??
        row.unrealisedPnl ??
        row.unrealized_pnl ??
        row.unrealised_pnl
    );

    out.push({
      exchange: exchange.toLowerCase(),
      symbol,
      side,
      size,
      ...(entryPrice !== null ? { entryPrice } : {}),
      ...(unrealizedPnl !== null ? { unrealizedPnl } : {}),
    });
  }

  // Collapse duplicates (same symbol+side) by summing size
  const merged = new Map<string, CanonicalPosition>();
  for (const p of out) {
    const key = `${p.symbol}:${p.side}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, p);
    } else {
      merged.set(key, {
        ...prev,
        size: prev.size + p.size,
        entryPrice: p.entryPrice ?? prev.entryPrice,
        unrealizedPnl:
          prev.unrealizedPnl != null || p.unrealizedPnl != null
            ? (prev.unrealizedPnl ?? 0) + (p.unrealizedPnl ?? 0)
            : undefined,
      });
    }
  }
  return [...merged.values()];
}

function unwrapPositionList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  // Bybit v5: { result: { list: [...] } }
  if (o.result && typeof o.result === "object") {
    const r = o.result as Record<string, unknown>;
    if (Array.isArray(r.list)) return r.list;
    if (Array.isArray(r.data)) return r.data;
  }
  // MEXC: { data: [...] } or { success: true, data: [...] }
  if (Array.isArray(o.data)) return o.data;
  if (Array.isArray(o.positions)) return o.positions;
  return [];
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseSide(raw: unknown): "LONG" | "SHORT" | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (s === "LONG" || s === "BUY") return "LONG";
  if (s === "SHORT" || s === "SELL") return "SHORT";
  // Binance BOTH / net-mode uses signed positionAmt instead
  return null;
}

/** Pure diff: desired open set from exchange vs current D1 OPEN rows. */
export function computePositionDiff(
  exchange: string,
  exchangePositions: CanonicalPosition[],
  d1Open: D1OpenPositionRow[],
  testnet: boolean
): {
  upserts: Array<{
    id: string;
    exchange: string;
    symbol: string;
    side: "LONG" | "SHORT";
    size: number;
    status: "OPEN" | "CLOSED";
  }>;
  unchanged: number;
} {
  const ex = exchange.toLowerCase();
  const desired = new Map<string, CanonicalPosition>();
  for (const p of exchangePositions) {
    desired.set(`${p.symbol}:${p.side}`, p);
  }

  const d1ForExchange = d1Open.filter(
    (r) =>
      r.exchange?.toLowerCase() === ex &&
      String(r.status).toUpperCase() === "OPEN" &&
      // Skip testnet IDs when reconciling live and vice versa
      (testnet
        ? r.id.includes("-testnet-")
        : !r.id.includes("-testnet-"))
  );

  const upserts: Array<{
    id: string;
    exchange: string;
    symbol: string;
    side: "LONG" | "SHORT";
    size: number;
    status: "OPEN" | "CLOSED";
  }> = [];
  let unchanged = 0;

  const seenD1Keys = new Set<string>();

  for (const row of d1ForExchange) {
    const side =
      String(row.side).toUpperCase() === "SHORT" ? "SHORT" : "LONG";
    const symbol = String(row.symbol).toUpperCase();
    const key = `${symbol}:${side}`;
    seenD1Keys.add(key);
    const live = desired.get(key);
    const d1Size = Math.abs(Number(row.size) || 0);

    if (!live || live.size <= SIZE_EPS) {
      upserts.push({
        id: row.id || positionId(ex, symbol, side, testnet),
        exchange: ex,
        symbol,
        side,
        size: 0,
        status: "CLOSED",
      });
      continue;
    }

    if (Math.abs(live.size - d1Size) > SIZE_EPS) {
      upserts.push({
        id: row.id || positionId(ex, symbol, side, testnet),
        exchange: ex,
        symbol,
        side,
        size: live.size,
        status: "OPEN",
      });
    } else {
      unchanged += 1;
    }
  }

  for (const [key, live] of desired) {
    if (seenD1Keys.has(key)) continue;
    upserts.push({
      id: positionId(ex, live.symbol, live.side, testnet),
      exchange: ex,
      symbol: live.symbol,
      side: live.side,
      size: live.size,
      status: "OPEN",
    });
  }

  return { upserts, unchanged };
}

async function fetchD1OpenPositions(
  env: Env
): Promise<D1OpenPositionRow[]> {
  if (!env.D1_SERVICE) {
    throw new Error("D1_SERVICE binding not configured");
  }
  if (!resolveInternalAuthKey(env, D1_READ_AUTH_KEY_FIELDS)) {
    throw new Error("D1 read auth key not configured");
  }

  // Prefer dashboard endpoint (fixed template), fall back to /query
  try {
    const res = await authenticatedServiceFetch(
      env.D1_SERVICE,
      env,
      "/api/dashboard/positions",
      undefined,
      { method: "GET", internalKeyFields: D1_READ_AUTH_KEY_FIELDS }
    );
    if (res.ok) {
      const body = (await res.json()) as {
        positions?: D1OpenPositionRow[];
        results?: D1OpenPositionRow[];
      };
      if (Array.isArray(body.positions)) return body.positions;
      if (Array.isArray(body.results)) return body.results;
    }
  } catch (e) {
    logger.warn("dashboard/positions failed, trying /query", {
      error: toError(e),
    });
  }

  const res = await authenticatedServiceFetch(
    env.D1_SERVICE,
    env,
    "/query",
    {
      query:
        "SELECT id, exchange, symbol, side, size, status FROM positions WHERE status = 'OPEN'",
      params: [],
    },
    { internalKeyFields: D1_READ_AUTH_KEY_FIELDS }
  );
  if (!res.ok) {
    throw new Error(`D1 query failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    success?: boolean;
    results?: D1OpenPositionRow[];
  };
  return Array.isArray(body.results) ? body.results : [];
}

async function upsertD1Position(
  env: Env,
  row: {
    id: string;
    exchange: string;
    symbol: string;
    side: string;
    size: number;
    status: string;
  }
): Promise<void> {
  if (!env.D1_SERVICE) {
    throw new Error("D1_SERVICE binding not configured");
  }
  if (!resolveInternalAuthKey(env, D1_WRITE_AUTH_KEY_FIELDS)) {
    throw new Error("D1 write auth key not configured");
  }
  const res = await authenticatedServiceFetch(
    env.D1_SERVICE,
    env,
    "/rpc/upsert-position",
    {
      id: row.id,
      exchange: row.exchange,
      symbol: row.symbol,
      side: row.side,
      size: row.size,
      status: row.status,
      updated_at: Math.floor(Date.now() / 1000),
    },
    { internalKeyFields: D1_WRITE_AUTH_KEY_FIELDS }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upsert-position ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** Build an exchange REST client for reconciliation (live or testnet). */
export function createReconcileClient(
  exchange: string,
  env: Env,
  testnet: boolean
): IExchangeClient {
  const creds = resolveExchangeCredentials(exchange, env, testnet);
  if (!creds) {
    throw new Error(
      testnet
        ? `${exchange} testnet/live API secrets unavailable.`
        : `${exchange} API secrets unavailable.`
    );
  }
  const opts = { testnet };
  switch (exchange.toLowerCase()) {
    case "binance":
      return factories.createBinanceClient(creds.apiKey, creds.apiSecret, opts);
    case "bybit":
      return factories.createBybitClient(creds.apiKey, creds.apiSecret, opts);
    case "mexc":
      return factories.createMexcClient(creds.apiKey, creds.apiSecret, opts);
    default:
      throw new Error(`Unsupported exchange: ${exchange}`);
  }
}

/** Reconcile a single exchange; never throws — failures become status "error". */
async function reconcileOneExchange(
  exchange: string,
  env: Env,
  ctx: {
    testnet: boolean;
    dryRun: boolean;
    clients?: Partial<Record<string, IExchangeClient>>;
    d1Open: D1OpenPositionRow[];
  }
): Promise<ExchangeReconcileResult> {
  const { testnet, dryRun, clients, d1Open } = ctx;

  if (!SUPPORTED_EXCHANGES.includes(exchange as ReconcileExchange)) {
    return {
      exchange,
      status: "skipped",
      reason: "unsupported_exchange",
      exchangeOpen: 0,
      d1OpenBefore: 0,
      upserted: 0,
      closed: 0,
      unchanged: 0,
      errors: [],
    };
  }

  if (!clients?.[exchange] && !hasExchangeCredentials(exchange, env, testnet)) {
    return {
      exchange,
      status: "skipped",
      reason: "no_credentials",
      exchangeOpen: 0,
      d1OpenBefore: 0,
      upserted: 0,
      closed: 0,
      unchanged: 0,
      errors: [],
    };
  }

  try {
    const client =
      clients?.[exchange] ?? createReconcileClient(exchange, env, testnet);

    const raw = await client.getPositions();
    const live = normalizeExchangePositions(exchange, raw);
    const { upserts, unchanged } = computePositionDiff(
      exchange,
      live,
      d1Open,
      testnet
    );

    let upserted = 0;
    let closed = 0;
    const errors: string[] = [];

    // Sequential D1 writes within an exchange (stable upsert order per exchange).
    for (const row of upserts) {
      if (dryRun) {
        if (row.status === "CLOSED") closed += 1;
        else upserted += 1;
        continue;
      }
      try {
        await upsertD1Position(env, row);
        if (row.status === "CLOSED") closed += 1;
        else upserted += 1;
      } catch (e) {
        errors.push(`${row.id}: ${toError(e)}`);
      }
    }

    const d1OpenBefore = d1Open.filter(
      (r) =>
        r.exchange?.toLowerCase() === exchange &&
        String(r.status).toUpperCase() === "OPEN" &&
        (testnet ? r.id.includes("-testnet-") : !r.id.includes("-testnet-"))
    ).length;

    return {
      exchange,
      status: errors.length ? "error" : "ok",
      exchangeOpen: live.length,
      d1OpenBefore,
      upserted,
      closed,
      unchanged,
      errors,
    };
  } catch (e) {
    return {
      exchange,
      status: "error",
      reason: toError(e),
      exchangeOpen: 0,
      d1OpenBefore: 0,
      upserted: 0,
      closed: 0,
      unchanged: 0,
      errors: [toError(e)],
    };
  }
}

/**
 * Reconcile all configured exchanges against D1 open positions.
 */
export async function reconcilePositions(
  env: Env,
  options: ReconcileOptions = {}
): Promise<ReconcileSummary> {
  const testnet = options.testnet === true;
  const dryRun = options.dryRun === true;
  const wanted = (options.exchanges ?? [...SUPPORTED_EXCHANGES]).map((e) =>
    e.toLowerCase()
  );

  let d1Open: D1OpenPositionRow[] = options.d1OpenRows ?? [];
  if (!options.d1OpenRows) {
    try {
      d1Open = await fetchD1OpenPositions(env);
    } catch (e) {
      logger.error("Failed to load D1 open positions", { error: toError(e) });
      return {
        timestamp: new Date().toISOString(),
        testnet,
        exchanges: wanted.map((exchange) => ({
          exchange,
          status: "error",
          reason: `d1_read: ${toError(e)}`,
          exchangeOpen: 0,
          d1OpenBefore: 0,
          upserted: 0,
          closed: 0,
          unchanged: 0,
          errors: [toError(e)],
        })),
        totals: {
          upserted: 0,
          closed: 0,
          unchanged: 0,
          errors: wanted.length,
        },
      };
    }
  }

  // Independent exchanges: fetch + diff in parallel (bounded). D1 upserts stay
  // sequential within each exchange; position IDs are namespaced by exchange so
  // concurrent cross-exchange writes do not collide.
  const exchangeResults = await mapPool(
    wanted,
    RECONCILE_EXCHANGE_CONCURRENCY,
    (exchange) =>
      reconcileOneExchange(exchange, env, {
        testnet,
        dryRun,
        clients: options.clients,
        d1Open,
      })
  );

  const totals = exchangeResults.reduce(
    (acc, r) => ({
      upserted: acc.upserted + r.upserted,
      closed: acc.closed + r.closed,
      unchanged: acc.unchanged + r.unchanged,
      errors:
        acc.errors +
        r.errors.length +
        (r.status === "error" && r.reason ? 1 : 0),
    }),
    { upserted: 0, closed: 0, unchanged: 0, errors: 0 }
  );

  logger.info("Position reconciliation complete", { testnet, dryRun, totals });

  return {
    timestamp: new Date().toISOString(),
    testnet,
    exchanges: exchangeResults,
    totals,
  };
}
