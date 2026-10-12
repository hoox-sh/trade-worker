/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  computePositionDiff,
  createReconcileClient,
  mapPool,
  normalizeExchangePositions,
  reconcilePositions,
  type D1OpenPositionRow,
} from "../src/reconcile";
import { factories } from "../src/exchange-router";
import type { IExchangeClient } from "../src/execution";

function mockClient(getPositions: () => Promise<unknown>): IExchangeClient {
  return {
    getPositions,
    getAccountInfo: async () => ({}),
    openLong: async () => ({}),
    openShort: async () => ({}),
    closeLong: async () => ({}),
    closeShort: async () => ({}),
  } as IExchangeClient;
}

describe("mapPool", () => {
  it("preserves input order with bounded concurrency", async () => {
    const started: number[] = [];
    const maxInFlight = { n: 0, peak: 0 };
    let inFlight = 0;

    const out = await mapPool([1, 2, 3, 4, 5], 2, async (x) => {
      started.push(x);
      inFlight += 1;
      maxInFlight.peak = Math.max(maxInFlight.peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return x * 10;
    });

    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(maxInFlight.peak).toBeLessThanOrEqual(2);
    expect(maxInFlight.peak).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for empty input", async () => {
    expect(await mapPool([], 3, async (x) => x)).toEqual([]);
  });
});

describe("normalizeExchangePositions", () => {
  it("maps Binance positionRisk signed amounts", () => {
    const out = normalizeExchangePositions("binance", [
      {
        symbol: "BTCUSDT",
        positionAmt: "0.5",
        entryPrice: "50000",
        unrealizedProfit: "10",
      },
      {
        symbol: "ETHUSDT",
        positionAmt: "-2",
        entryPrice: "3000",
      },
      { symbol: "SOLUSDT", positionAmt: "0" },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((p) => p.symbol === "BTCUSDT")).toMatchObject({
      side: "LONG",
      size: 0.5,
      entryPrice: 50000,
    });
    expect(out.find((p) => p.symbol === "ETHUSDT")).toMatchObject({
      side: "SHORT",
      size: 2,
    });
  });

  it("maps Bybit v5 list wrapper with explicit side", () => {
    const out = normalizeExchangePositions("bybit", {
      result: {
        list: [
          {
            symbol: "BTCUSDT",
            side: "Buy",
            size: "0.01",
            avgPrice: "60000",
            unrealisedPnl: "1.5",
          },
        ],
      },
    });
    expect(out).toEqual([
      expect.objectContaining({
        exchange: "bybit",
        symbol: "BTCUSDT",
        side: "LONG",
        size: 0.01,
        entryPrice: 60000,
        unrealizedPnl: 1.5,
      }),
    ]);
  });

  it("maps shared Position shape", () => {
    const out = normalizeExchangePositions("mexc", [
      {
        symbol: "BTCUSDT",
        side: "short",
        quantity: 1.25,
        entryPrice: 100,
      },
    ]);
    expect(out[0]).toMatchObject({
      side: "SHORT",
      size: 1.25,
    });
  });
});

describe("computePositionDiff", () => {
  const d1: D1OpenPositionRow[] = [
    {
      id: "binance-BTCUSDT-LONG",
      exchange: "binance",
      symbol: "BTCUSDT",
      side: "LONG",
      size: 1,
      status: "OPEN",
    },
    {
      id: "binance-ETHUSDT-SHORT",
      exchange: "binance",
      symbol: "ETHUSDT",
      side: "SHORT",
      size: 2,
      status: "OPEN",
    },
  ];

  it("closes D1 rows missing on exchange", () => {
    const { upserts, unchanged } = computePositionDiff(
      "binance",
      [
        {
          exchange: "binance",
          symbol: "BTCUSDT",
          side: "LONG",
          size: 1,
        },
      ],
      d1,
      false
    );
    expect(unchanged).toBe(1);
    expect(upserts).toContainEqual(
      expect.objectContaining({
        id: "binance-ETHUSDT-SHORT",
        status: "CLOSED",
        size: 0,
      })
    );
  });

  it("upserts size changes and new opens", () => {
    const { upserts } = computePositionDiff(
      "binance",
      [
        {
          exchange: "binance",
          symbol: "BTCUSDT",
          side: "LONG",
          size: 1.5,
        },
        {
          exchange: "binance",
          symbol: "SOLUSDT",
          side: "LONG",
          size: 10,
        },
      ],
      d1,
      false
    );
    expect(upserts).toContainEqual(
      expect.objectContaining({
        symbol: "BTCUSDT",
        size: 1.5,
        status: "OPEN",
      })
    );
    expect(upserts).toContainEqual(
      expect.objectContaining({
        id: "binance-SOLUSDT-LONG",
        status: "OPEN",
        size: 10,
      })
    );
    expect(upserts).toContainEqual(
      expect.objectContaining({
        symbol: "ETHUSDT",
        status: "CLOSED",
      })
    );
  });

  it("ignores testnet D1 rows on live reconcile", () => {
    const mixed: D1OpenPositionRow[] = [
      ...d1,
      {
        id: "binance-testnet-BTCUSDT-LONG",
        exchange: "binance",
        symbol: "BTCUSDT",
        side: "LONG",
        size: 99,
        status: "OPEN",
      },
    ];
    const { upserts, unchanged } = computePositionDiff(
      "binance",
      [
        {
          exchange: "binance",
          symbol: "BTCUSDT",
          side: "LONG",
          size: 1,
        },
        {
          exchange: "binance",
          symbol: "ETHUSDT",
          side: "SHORT",
          size: 2,
        },
      ],
      mixed,
      false
    );
    expect(unchanged).toBe(2);
    expect(upserts).toHaveLength(0);
  });
});

describe("reconcilePositions", () => {
  it("skips exchanges without credentials", async () => {
    const summary = await reconcilePositions(
      { CONFIG_KV: undefined } as never,
      {
        exchanges: ["binance"],
        d1OpenRows: [],
      }
    );
    expect(summary.exchanges[0]).toMatchObject({
      exchange: "binance",
      status: "skipped",
      reason: "no_credentials",
    });
  });

  it("dry-run diffs with injected client", async () => {
    const client = mockClient(async () => [
      { symbol: "BTCUSDT", positionAmt: "0.1", entryPrice: "1" },
    ]);

    const summary = await reconcilePositions({} as never, {
      exchanges: ["binance"],
      clients: { binance: client },
      d1OpenRows: [
        {
          id: "binance-ETHUSDT-LONG",
          exchange: "binance",
          symbol: "ETHUSDT",
          side: "LONG",
          size: 1,
          status: "OPEN",
        },
      ],
      dryRun: true,
    });

    expect(summary.exchanges[0]?.status).toBe("ok");
    expect(summary.exchanges[0]?.upserted).toBe(1); // new BTC open
    expect(summary.exchanges[0]?.closed).toBe(1); // ETH closed
    expect(summary.totals.upserted + summary.totals.closed).toBe(2);
  });

  it("runs independent exchanges in parallel and isolates failures", async () => {
    let inFlight = 0;
    let peak = 0;

    const slowOk = mockClient(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Hold both successful fetches open so they overlap with each other / the failer.
      await new Promise((r) => setTimeout(r, 40));
      inFlight -= 1;
      return [{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "1" }];
    });

    const failer = mockClient(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      throw new Error("exchange_down");
    });

    const bybitOk = mockClient(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight -= 1;
      return {
        result: {
          list: [
            {
              symbol: "ETHUSDT",
              side: "Buy",
              size: "2",
              avgPrice: "3000",
            },
          ],
        },
      };
    });

    const t0 = Date.now();
    const summary = await reconcilePositions({} as never, {
      exchanges: ["binance", "mexc", "bybit"],
      clients: {
        binance: slowOk,
        mexc: failer,
        bybit: bybitOk,
      },
      d1OpenRows: [],
      dryRun: true,
    });
    const elapsed = Date.now() - t0;

    // Order matches requested exchanges
    expect(summary.exchanges.map((e) => e.exchange)).toEqual([
      "binance",
      "mexc",
      "bybit",
    ]);
    expect(summary.exchanges[0]).toMatchObject({
      exchange: "binance",
      status: "ok",
      upserted: 1,
    });
    expect(summary.exchanges[1]).toMatchObject({
      exchange: "mexc",
      status: "error",
      reason: expect.stringContaining("exchange_down"),
    });
    expect(summary.exchanges[2]).toMatchObject({
      exchange: "bybit",
      status: "ok",
      upserted: 1,
    });
    // Fail-closed isolation: one error must not cancel other exchanges
    expect(summary.totals.upserted).toBe(2);
    expect(summary.totals.errors).toBeGreaterThanOrEqual(1);
    // Overlapping fetches (not fully sequential ~80ms+ of 40+40)
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(100);
  });

  it("skips unsupported exchanges alongside successful ones", async () => {
    const client = mockClient(async () => [
      { symbol: "BTCUSDT", positionAmt: "0.5", entryPrice: "1" },
    ]);
    const summary = await reconcilePositions({} as never, {
      exchanges: ["binance", "kraken"],
      clients: { binance: client },
      d1OpenRows: [],
      dryRun: true,
    });
    expect(summary.exchanges).toEqual([
      expect.objectContaining({ exchange: "binance", status: "ok" }),
      expect.objectContaining({
        exchange: "kraken",
        status: "skipped",
        reason: "unsupported_exchange",
      }),
    ]);
  });

  it("skips DEX spot venues without closing holdings", async () => {
    const summary = await reconcilePositions(
      { WEB3_WALLET_SERVICE: {} } as never,
      {
        exchanges: ["uniswap-ethereum", "jupiter-solana"],
        d1OpenRows: [],
        dryRun: true,
      }
    );
    expect(summary.exchanges).toEqual([
      expect.objectContaining({
        exchange: "uniswap-ethereum",
        status: "skipped",
        reason: "dex_spot_no_reconcile",
      }),
      expect.objectContaining({
        exchange: "jupiter-solana",
        status: "skipped",
        reason: "dex_spot_no_reconcile",
      }),
    ]);
  });

  it("reports no_credentials for DEX venues without a wallet binding", async () => {
    const summary = await reconcilePositions({} as never, {
      exchanges: ["uniswap-ethereum"],
      d1OpenRows: [],
      dryRun: true,
    });
    expect(summary.exchanges[0]).toMatchObject({
      exchange: "uniswap-ethereum",
      status: "skipped",
      reason: "no_credentials",
    });
  });
});

describe("normalizeExchangePositions duplicates and envelopes", () => {
  it("merges duplicate symbol+side rows summing size and pnl", () => {
    const out = normalizeExchangePositions("binance", [
      {
        symbol: "BTCUSDT",
        positionAmt: "0.5",
        entryPrice: "50000",
        unrealizedPnl: "10",
      },
      {
        symbol: "BTCUSDT",
        positionAmt: "0.3",
        entryPrice: "51000",
        unrealizedPnl: "5",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      symbol: "BTCUSDT",
      side: "LONG",
      entryPrice: 51000,
      unrealizedPnl: 15,
    });
    expect(out[0]?.size).toBeCloseTo(0.8);
  });

  it("merges duplicates without pnl leaving pnl undefined", () => {
    const out = normalizeExchangePositions("binance", [
      { symbol: "ETHUSDT", positionAmt: "1" },
      { symbol: "ETHUSDT", positionAmt: "2" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: "ETHUSDT", side: "LONG" });
    expect(out[0]?.size).toBeCloseTo(3);
    expect(out[0]?.unrealizedPnl).toBeUndefined();
  });

  it("sums pnl when only one duplicate carries pnl", () => {
    const out = normalizeExchangePositions("binance", [
      { symbol: "ETHUSDT", positionAmt: "1", unrealizedPnl: "4" },
      { symbol: "ETHUSDT", positionAmt: "2" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.unrealizedPnl).toBe(4);
  });

  it("unwraps result.data lists", () => {
    const out = normalizeExchangePositions("bybit", {
      result: {
        data: [{ symbol: "BTCUSDT", side: "Sell", size: "0.5" }],
      },
    });
    expect(out).toEqual([
      expect.objectContaining({
        symbol: "BTCUSDT",
        side: "SHORT",
        size: 0.5,
      }),
    ]);
  });

  it("unwraps top-level data envelopes", () => {
    const out = normalizeExchangePositions("mexc", {
      success: true,
      data: [{ symbol: "BTCUSDT", side: "LONG", quantity: 2 }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: "BTCUSDT", size: 2 });
  });

  it("unwraps top-level positions arrays", () => {
    const out = normalizeExchangePositions("mexc", {
      positions: [{ symbol: "BTCUSDT", side: "LONG", quantity: 2 }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: "BTCUSDT", size: 2 });
  });

  it("returns [] for payloads without a position list", () => {
    expect(normalizeExchangePositions("binance", { foo: 1 })).toEqual([]);
    expect(normalizeExchangePositions("binance", null)).toEqual([]);
    expect(normalizeExchangePositions("binance", "nope")).toEqual([]);
    expect(normalizeExchangePositions("binance", 42)).toEqual([]);
  });
});

describe("createReconcileClient", () => {
  const credEnv = {
    BINANCE_KEY_BINDING: "bin-key",
    BINANCE_SECRET_BINDING: "bin-secret",
    BYBIT_KEY_BINDING: "by-key",
    BYBIT_SECRET_BINDING: "by-secret",
    MEXC_KEY_BINDING: "mexc-key",
    MEXC_SECRET_BINDING: "mexc-secret",
  } as never;

  const stub = mockClient(async () => []);
  let spies: ReturnType<typeof spyOn>[] = [];

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies = [];
  });

  it("creates a binance client from live bindings", () => {
    const s = spyOn(factories, "createBinanceClient").mockReturnValue(
      stub as never
    );
    spies.push(s);
    expect(createReconcileClient("binance", credEnv, false)).toBe(stub);
    expect(s).toHaveBeenCalledWith("bin-key", "bin-secret", {
      testnet: false,
    });
  });

  it("creates a bybit client from live bindings", () => {
    const s = spyOn(factories, "createBybitClient").mockReturnValue(
      stub as never
    );
    spies.push(s);
    expect(createReconcileClient("bybit", credEnv, false)).toBe(stub);
    expect(s).toHaveBeenCalledWith("by-key", "by-secret", {
      testnet: false,
    });
  });

  it("creates a mexc client from live bindings", () => {
    const s = spyOn(factories, "createMexcClient").mockReturnValue(
      stub as never
    );
    spies.push(s);
    expect(createReconcileClient("mexc", credEnv, false)).toBe(stub);
    expect(s).toHaveBeenCalledWith("mexc-key", "mexc-secret", {
      testnet: false,
    });
  });

  it("forwards the testnet flag to the factory", () => {
    const s = spyOn(factories, "createBinanceClient").mockReturnValue(
      stub as never
    );
    spies.push(s);
    createReconcileClient("binance", credEnv, true);
    expect(s).toHaveBeenCalledWith("bin-key", "bin-secret", {
      testnet: true,
    });
  });

  it("throws when live credentials are missing", () => {
    expect(() => createReconcileClient("binance", {} as never, false)).toThrow(
      "API secrets unavailable"
    );
  });

  it("throws a testnet-specific message when testnet credentials are missing", () => {
    expect(() => createReconcileClient("binance", {} as never, true)).toThrow(
      "testnet/live API secrets unavailable"
    );
  });

  it("throws for unsupported exchanges without credentials", () => {
    expect(() => createReconcileClient("kraken", {} as never, false)).toThrow(
      "API secrets unavailable"
    );
  });

  it("throws for DEX venues without CEX credentials", () => {
    expect(() =>
      createReconcileClient(
        "uniswap-ethereum",
        { WEB3_WALLET_SERVICE: {} } as never,
        false
      )
    ).toThrow("API secrets unavailable");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function d1FetchMock(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response
): {
  fetch: (url: string | Request, init?: RequestInit) => Promise<Response>;
} {
  return {
    fetch: (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      return Promise.resolve(handler(u, init));
    },
  };
}

describe("reconcilePositions with D1 service binding", () => {
  const d1Row: D1OpenPositionRow = {
    id: "binance-BTCUSDT-LONG",
    exchange: "binance",
    symbol: "BTCUSDT",
    side: "LONG",
    size: 1,
    status: "OPEN",
  };

  it("loads D1 rows via the dashboard positions endpoint and writes diffs", async () => {
    const written: unknown[] = [];
    const d1 = d1FetchMock((url, init) => {
      if (url.includes("/api/dashboard/positions")) {
        return jsonResponse({ positions: [d1Row] });
      }
      if (url.includes("/rpc/upsert-position")) {
        written.push(JSON.parse(String(init?.body)));
        return jsonResponse({ success: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const summary = await reconcilePositions(
      { INTERNAL_KEY_BINDING: "k", D1_SERVICE: d1 } as never,
      {
        exchanges: ["binance"],
        clients: { binance: mockClient(async () => []) },
      }
    );
    expect(summary.exchanges[0]).toMatchObject({
      status: "ok",
      closed: 1,
      upserted: 0,
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      id: "binance-BTCUSDT-LONG",
      status: "CLOSED",
      size: 0,
    });
  });

  it("accepts the dashboard results envelope", async () => {
    let writes = 0;
    const d1 = d1FetchMock((url) => {
      if (url.includes("/api/dashboard/positions")) {
        return jsonResponse({ results: [d1Row] });
      }
      if (url.includes("/rpc/upsert-position")) {
        writes += 1;
        return jsonResponse({ success: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const summary = await reconcilePositions(
      { INTERNAL_KEY_BINDING: "k", D1_SERVICE: d1 } as never,
      {
        exchanges: ["binance"],
        clients: {
          binance: mockClient(async () => [
            { symbol: "BTCUSDT", positionAmt: "1", entryPrice: "1" },
          ]),
        },
      }
    );
    expect(summary.exchanges[0]).toMatchObject({
      status: "ok",
      unchanged: 1,
      upserted: 0,
      closed: 0,
    });
    expect(writes).toBe(0);
  });

  it("falls back to /rpc/list-open-positions when dashboard is not ok", async () => {
    const seen: string[] = [];
    const d1 = d1FetchMock((url, init) => {
      seen.push(url);
      if (url.includes("/api/dashboard/positions")) {
        return new Response("boom", { status: 500 });
      }
      if (url.includes("/rpc/list-open-positions")) {
        return jsonResponse({ positions: [d1Row] });
      }
      if (url.includes("/rpc/upsert-position")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          id: "binance-BTCUSDT-LONG",
          status: "CLOSED",
        });
        return jsonResponse({ success: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const summary = await reconcilePositions(
      { INTERNAL_KEY_BINDING: "k", D1_SERVICE: d1 } as never,
      {
        exchanges: ["binance"],
        clients: { binance: mockClient(async () => []) },
      }
    );
    expect(summary.exchanges[0]).toMatchObject({
      status: "ok",
      closed: 1,
    });
    expect(seen.some((u) => u.includes("/rpc/list-open-positions"))).toBe(true);
  });

  it("accepts the rpc results envelope on fallback", async () => {
    const d1 = d1FetchMock((url) => {
      if (url.includes("/api/dashboard/positions")) {
        return jsonResponse({});
      }
      if (url.includes("/rpc/list-open-positions")) {
        return jsonResponse({ results: [d1Row] });
      }
      if (url.includes("/rpc/upsert-position")) {
        return jsonResponse({ success: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const summary = await reconcilePositions(
      { INTERNAL_KEY_BINDING: "k", D1_SERVICE: d1 } as never,
      {
        exchanges: ["binance"],
        clients: {
          binance: mockClient(async () => [
            { symbol: "BTCUSDT", positionAmt: "1" },
          ]),
        },
      }
    );
    expect(summary.exchanges[0]).toMatchObject({
      status: "ok",
      unchanged: 1,
    });
  });

  it("treats an rpc payload without rows as empty", async () => {
    const d1 = d1FetchMock((url) => {
      if (url.includes("/api/dashboard/positions")) {
        return new Response("boom", { status: 500 });
      }
      if (url.includes("/rpc/list-open-positions")) {
        return jsonResponse({ success: true });
      }
      if (url.includes("/rpc/upsert-position")) {
        return jsonResponse({ success: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const summary = await reconcilePositions(
      { INTERNAL_KEY_BINDING: "k", D1_SERVICE: d1 } as never,
      {
        exchanges: ["binance"],
        clients: {
          binance: mockClient(async () => [
            { symbol: "BTCUSDT", positionAmt: "1" },
          ]),
        },
      }
    );
    expect(summary.exchanges[0]).toMatchObject({
      status: "ok",
      upserted: 1,
      closed: 0,
    });
  });

  it("retries rpc after the dashboard fetch throws", async () => {
    let dashboardCalls = 0;
    const d1 = d1FetchMock((url) => {
      if (url.includes("/api/dashboard/positions")) {
        dashboardCalls += 1;
        throw new Error("d1 down");
      }
      if (url.includes("/rpc/list-open-positions")) {
        return jsonResponse({ results: [d1Row] });
      }
      if (url.includes("/rpc/upsert-position")) {
        return jsonResponse({ success: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const summary = await reconcilePositions(
      { INTERNAL_KEY_BINDING: "k", D1_SERVICE: d1 } as never,
      {
        exchanges: ["binance"],
        clients: {
          binance: mockClient(async () => [
            { symbol: "BTCUSDT", positionAmt: "1" },
          ]),
        },
      }
    );
    expect(dashboardCalls).toBe(1);
    expect(summary.exchanges[0]).toMatchObject({
      status: "ok",
      unchanged: 1,
    });
  });

  it("records per-row upsert failures and keeps the other rows", async () => {
    const d1 = d1FetchMock((url, init) => {
      if (url.includes("/rpc/upsert-position")) {
        const body = JSON.parse(String(init?.body)) as { id: string };
        if (body.id.includes("ETHUSDT")) {
          return new Response("nope", { status: 500 });
        }
        return jsonResponse({ success: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const summary = await reconcilePositions(
      { INTERNAL_KEY_BINDING: "k", D1_SERVICE: d1 } as never,
      {
        exchanges: ["binance"],
        clients: {
          binance: mockClient(async () => [
            { symbol: "BTCUSDT", positionAmt: "1" },
            { symbol: "ETHUSDT", positionAmt: "2" },
          ]),
        },
        d1OpenRows: [],
      }
    );
    const ex = summary.exchanges[0];
    expect(ex?.status).toBe("error");
    expect(ex?.upserted).toBe(1);
    expect(ex?.errors).toHaveLength(1);
    expect(ex?.errors[0]).toContain("binance-ETHUSDT-LONG");
  });

  it("surfaces a missing D1 write auth key as per-row errors", async () => {
    const d1 = d1FetchMock(() => {
      throw new Error("should not be called");
    });
    const summary = await reconcilePositions({ D1_SERVICE: d1 } as never, {
      exchanges: ["binance"],
      clients: {
        binance: mockClient(async () => [
          { symbol: "BTCUSDT", positionAmt: "1" },
        ]),
      },
      d1OpenRows: [],
    });
    expect(summary.exchanges[0]?.status).toBe("error");
    expect(summary.exchanges[0]?.errors[0]).toContain(
      "D1 write auth key not configured"
    );
  });

  it("surfaces a missing D1_SERVICE binding on write as per-row errors", async () => {
    const summary = await reconcilePositions({} as never, {
      exchanges: ["binance"],
      clients: {
        binance: mockClient(async () => [
          { symbol: "BTCUSDT", positionAmt: "1" },
        ]),
      },
      d1OpenRows: [],
    });
    expect(summary.exchanges[0]?.status).toBe("error");
    expect(summary.exchanges[0]?.errors[0]).toContain(
      "D1_SERVICE binding not configured"
    );
  });

  it("runs an injected DEX client through the normal diff instead of skipping", async () => {
    const summary = await reconcilePositions({} as never, {
      exchanges: ["uniswap-ethereum"],
      clients: {
        "uniswap-ethereum": mockClient(async () => [
          { symbol: "BTCUSDT", side: "LONG", quantity: 1 },
        ]),
      },
      d1OpenRows: [],
      dryRun: true,
    });
    expect(summary.exchanges[0]).toMatchObject({
      exchange: "uniswap-ethereum",
      status: "ok",
      upserted: 1,
    });
  });
});

describe("reconcilePositions D1 read failures", () => {
  it("returns d1_read errors when the rpc list fails", async () => {
    const d1 = d1FetchMock((url) => {
      if (url.includes("/api/dashboard/positions")) {
        return new Response("x", { status: 500 });
      }
      if (url.includes("/rpc/list-open-positions")) {
        return new Response("db down", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const summary = await reconcilePositions(
      { INTERNAL_KEY_BINDING: "k", D1_SERVICE: d1 } as never,
      { exchanges: ["binance", "bybit"] }
    );
    expect(summary.exchanges).toHaveLength(2);
    for (const ex of summary.exchanges) {
      expect(ex.status).toBe("error");
      expect(ex.reason).toContain("d1_read");
    }
    expect(summary.totals.errors).toBe(2);
    expect(summary.totals.upserted).toBe(0);
  });

  it("returns d1_read errors when D1_SERVICE is not configured", async () => {
    const summary = await reconcilePositions(
      { INTERNAL_KEY_BINDING: "k" } as never,
      { exchanges: ["binance"] }
    );
    expect(summary.exchanges[0]?.status).toBe("error");
    expect(summary.exchanges[0]?.reason).toContain("d1_read");
    expect(summary.exchanges[0]?.reason).toContain(
      "D1_SERVICE binding not configured"
    );
  });

  it("returns d1_read errors when the D1 read key is missing", async () => {
    const d1 = d1FetchMock(() => {
      throw new Error("should not be called");
    });
    const summary = await reconcilePositions({ D1_SERVICE: d1 } as never, {
      exchanges: ["binance"],
    });
    expect(summary.exchanges[0]?.status).toBe("error");
    expect(summary.exchanges[0]?.reason).toContain("d1_read");
    expect(summary.exchanges[0]?.reason).toContain(
      "D1 read auth key not configured"
    );
  });
});
