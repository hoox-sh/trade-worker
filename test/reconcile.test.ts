/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "bun:test";
import {
  computePositionDiff,
  mapPool,
  normalizeExchangePositions,
  reconcilePositions,
  type D1OpenPositionRow,
} from "../src/reconcile";
import type { IExchangeClient } from "../src/execution";

function mockClient(
  getPositions: () => Promise<unknown>
): IExchangeClient {
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
});
