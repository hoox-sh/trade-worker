/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "bun:test";
import {
  computePositionDiff,
  normalizeExchangePositions,
  reconcilePositions,
  type D1OpenPositionRow,
} from "../src/reconcile";

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
    const client = {
      getPositions: async () => [
        { symbol: "BTCUSDT", positionAmt: "0.1", entryPrice: "1" },
      ],
      getAccountInfo: async () => ({}),
      openLong: async () => ({}),
      openShort: async () => ({}),
      closeLong: async () => ({}),
      closeShort: async () => ({}),
    };

    const summary = await reconcilePositions({} as never, {
      exchanges: ["binance"],
      clients: { binance: client as never },
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

    expect(summary.exchanges[0].status).toBe("ok");
    expect(summary.exchanges[0].upserted).toBe(1); // new BTC open
    expect(summary.exchanges[0].closed).toBe(1); // ETH closed
    expect(summary.totals.upserted + summary.totals.closed).toBe(2);
  });
});
