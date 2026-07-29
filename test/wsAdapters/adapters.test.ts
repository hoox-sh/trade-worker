/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/test/wsAdapters/adapters.test.ts
import { describe, test, expect } from "bun:test";
import { getAdapter } from "../../src/wsAdapters/adapters";

describe("getAdapter", () => {
  const creds = { apiKey: "ak", apiSecret: "sk" };

  test("returns Binance adapter for 'binance'", () => {
    const a = getAdapter("binance", creds);
    expect(a).toBeDefined();
    expect(a!.url).toBe("wss://ws-api.binance.com:443/ws-api/v3");
  });

  test("returns Bybit adapter for 'bybit'", () => {
    const a = getAdapter("bybit", creds);
    expect(a).toBeDefined();
    expect(a!.url).toBe("wss://api.bybit.com/v5/private");
  });

  test("returns MEXC adapter for 'mexc'", () => {
    const a = getAdapter("mexc", creds);
    expect(a).toBeDefined();
    expect(a!.url).toBe("wss://contract.mexc.com/edge");
  });

  test("is case-insensitive", () => {
    expect(getAdapter("BINANCE", creds)?.url).toBeDefined();
    expect(getAdapter("Binance", creds)?.url).toBeDefined();
  });

  test("returns undefined for unknown exchange", () => {
    expect(getAdapter("kraken", creds)).toBeUndefined();
    expect(getAdapter("", creds)).toBeUndefined();
  });

  test("returned adapters are configured instances (not shared)", () => {
    const a = getAdapter("binance", creds);
    const b = getAdapter("binance", creds);
    expect(a).not.toBe(b); // distinct instances (so each DO binds its own creds)
  });
});
