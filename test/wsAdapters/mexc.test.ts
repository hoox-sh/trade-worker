/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/test/wsAdapters/mexc.test.ts
import { describe, test, expect } from "bun:test";
import { MexcAdapter } from "../../src/wsAdapters/mexc";

describe("MexcAdapter", () => {
  const creds = { apiKey: "ak", apiSecret: "sk" };

  test("url points to contract edge", () => {
    const adapter = new MexcAdapter(creds);
    expect(adapter.url).toBe("wss://contract.mexc.com/edge");
  });

  test("buildRequest returns JSON with id, method, param", async () => {
    const adapter = new MexcAdapter(creds);
    const raw = await adapter.buildRequest("order.place", {
      symbol: "BTC_USDT",
      side: 1,
      vol: 0.01,
    });
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBeString();
    expect(parsed.method).toBe("order.place");
    expect(parsed.param.symbol).toBe("BTC_USDT");
    expect(parsed.param.side).toBe(1);
    expect(parsed.param.vol).toBe(0.01);
  });

  test("buildRequest produces a unique id per call", async () => {
    const adapter = new MexcAdapter(creds);
    const a = JSON.parse(await adapter.buildRequest("ping", {}));
    const b = JSON.parse(await adapter.buildRequest("ping", {}));
    expect(a.id).not.toBe(b.id);
  });

  test("parseResponse returns null for push event (no id)", () => {
    const adapter = new MexcAdapter(creds);
    expect(adapter.parseResponse('{"channel":"ticker","data":{}}')).toBeNull();
  });

  test("parseResponse returns result for success (code 0)", () => {
    const adapter = new MexcAdapter(creds);
    const id = "req-1";
    const raw = JSON.stringify({
      id,
      code: 0,
      data: { orderId: "o1" },
    });
    expect(adapter.parseResponse(raw)).toEqual({
      id,
      result: { orderId: "o1" },
    });
  });

  test("parseResponse returns error for non-zero code", () => {
    const adapter = new MexcAdapter(creds);
    const id = "req-2";
    const raw = JSON.stringify({
      id,
      code: 10401,
      msg: "Invalid signature",
    });
    expect(adapter.parseResponse(raw)).toEqual({
      id,
      error: { code: 10401, msg: "Invalid signature" },
    });
  });

  test("parseResponse returns null on malformed JSON", () => {
    const adapter = new MexcAdapter(creds);
    expect(adapter.parseResponse("not-json")).toBeNull();
  });
});
