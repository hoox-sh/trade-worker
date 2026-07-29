/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/test/wsAdapters/bybit.test.ts
import { describe, test, expect } from "bun:test";
import { BybitAdapter } from "../../src/wsAdapters/bybit";

describe("BybitAdapter", () => {
  const creds = { apiKey: "ak", apiSecret: "sk" };

  test("url points to v5 private stream", () => {
    const adapter = new BybitAdapter(creds);
    expect(adapter.url).toBe("wss://api.bybit.com/v5/private");
  });

  test("buildRequest returns JSON with reqId, op, args", async () => {
    const adapter = new BybitAdapter(creds);
    const raw = await adapter.buildRequest("order.create", {
      symbol: "BTCUSDT",
      side: "Buy",
      qty: "0.01",
    });
    const parsed = JSON.parse(raw);
    expect(parsed.reqId).toBeString();
    expect(parsed.op).toBe("order.create");
    expect(parsed.args.symbol).toBe("BTCUSDT");
    expect(parsed.args.side).toBe("Buy");
    expect(parsed.args.qty).toBe("0.01");
  });

  test("buildRequest produces a unique reqId per call", async () => {
    const adapter = new BybitAdapter(creds);
    const a = JSON.parse(await adapter.buildRequest("ping", {}));
    const b = JSON.parse(await adapter.buildRequest("ping", {}));
    expect(a.reqId).not.toBe(b.reqId);
  });

  test("parseResponse returns null for subscription push", () => {
    const adapter = new BybitAdapter(creds);
    expect(
      adapter.parseResponse('{"op":"subscribe","success":true}')
    ).toBeNull();
  });

  test("parseResponse returns result for success (retCode 0)", () => {
    const adapter = new BybitAdapter(creds);
    const reqId = "req-1";
    const raw = JSON.stringify({
      reqId,
      op: "order.create",
      retCode: 0,
      retMsg: "OK",
      result: { orderId: "o1" },
    });
    expect(adapter.parseResponse(raw)).toEqual({
      id: reqId,
      result: { orderId: "o1" },
    });
  });

  test("parseResponse returns error when retCode != 0", () => {
    const adapter = new BybitAdapter(creds);
    const reqId = "req-2";
    const raw = JSON.stringify({
      reqId,
      op: "order.create",
      retCode: 10001,
      retMsg: "Invalid apiKey",
      result: {},
    });
    expect(adapter.parseResponse(raw)).toEqual({
      id: reqId,
      error: { code: 10001, msg: "Invalid apiKey" },
    });
  });

  test("parseResponse returns null on malformed JSON", () => {
    const adapter = new BybitAdapter(creds);
    expect(adapter.parseResponse("not-json")).toBeNull();
  });
});
