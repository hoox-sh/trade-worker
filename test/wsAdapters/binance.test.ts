/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/test/wsAdapters/binance.test.ts
import { describe, test, expect } from "bun:test";
import { BinanceAdapter } from "../../src/wsAdapters/binance";

describe("BinanceAdapter", () => {
  const creds = { apiKey: "ak", apiSecret: "sk" };

  test("url points to ws-api v3", () => {
    const adapter = new BinanceAdapter(creds);
    expect(adapter.url).toBe("wss://ws-api.binance.com:443/ws-api/v3");
  });

  test("buildRequest returns JSON with id, method, params (incl. apiKey + signature)", async () => {
    const adapter = new BinanceAdapter(creds);
    const raw = await adapter.buildRequest("order.place", {
      symbol: "BTCUSDT",
      side: "BUY",
      type: "MARKET",
      quantity: 0.01,
    });
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBeString();
    expect(parsed.method).toBe("order.place");
    expect(parsed.params.symbol).toBe("BTCUSDT");
    expect(parsed.params.side).toBe("BUY");
    expect(parsed.params.type).toBe("MARKET");
    expect(parsed.params.quantity).toBe("0.01");
    expect(parsed.params.apiKey).toBe("ak");
    expect(parsed.params.signature).toBeString();
    expect(parsed.params.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  test("buildRequest uses bound creds (different creds → different apiKey + signature)", async () => {
    const a = new BinanceAdapter({ apiKey: "ak1", apiSecret: "sk1" });
    const b = new BinanceAdapter({ apiKey: "ak2", apiSecret: "sk2" });
    const pa = JSON.parse(await a.buildRequest("ping", {}));
    const pb = JSON.parse(await b.buildRequest("ping", {}));
    expect(pa.params.apiKey).toBe("ak1");
    expect(pb.params.apiKey).toBe("ak2");
    expect(pa.params.signature).not.toBe(pb.params.signature);
  });

  test("buildRequest produces a unique id per call", async () => {
    const adapter = new BinanceAdapter(creds);
    const a = JSON.parse(await adapter.buildRequest("ping", {}));
    const b = JSON.parse(await adapter.buildRequest("ping", {}));
    expect(a.id).not.toBe(b.id);
  });

  test("parseResponse returns null for push events (no id field)", () => {
    const adapter = new BinanceAdapter(creds);
    expect(
      adapter.parseResponse('{"e":"bookTicker","s":"BTCUSDT"}')
    ).toBeNull();
  });

  test("parseResponse returns result for success response (200)", () => {
    const adapter = new BinanceAdapter(creds);
    const id = "req-123";
    const raw = JSON.stringify({
      id,
      status: 200,
      result: { orderId: "o1", status: "FILLED" },
    });
    expect(adapter.parseResponse(raw)).toEqual({
      id,
      result: { orderId: "o1", status: "FILLED" },
    });
  });

  test("parseResponse returns error for failure response (status >= 400)", () => {
    const adapter = new BinanceAdapter(creds);
    const id = "req-456";
    const raw = JSON.stringify({
      id,
      status: 400,
      error: { code: -1002, msg: "Unauthorized" },
    });
    expect(adapter.parseResponse(raw)).toEqual({
      id,
      error: { code: -1002, msg: "Unauthorized" },
    });
  });

  test("parseResponse returns null on malformed JSON", () => {
    const adapter = new BinanceAdapter(creds);
    expect(adapter.parseResponse("not-json")).toBeNull();
  });
});
