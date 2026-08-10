/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, jest as vi } from "bun:test";
import {
  checkAndStoreIdempotency,
  resolveQueueIdempotencyKey,
  resolveTradeIdempotencyKey,
} from "../src/idempotency";

function createMockKv(store: Map<string, string> = new Map()) {
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
      store.set(key, value);
    }),
    list: vi.fn(),
    delete: vi.fn(),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

const samplePayload = {
  exchange: "binance",
  action: "LONG",
  symbol: "BTCUSDT",
  quantity: 0.01,
};

describe("resolveTradeIdempotencyKey", () => {
  test("prefers Idempotency-Key header over X-Request-ID and fingerprint", () => {
    const request = new Request("http://internal/webhook", {
      method: "POST",
      headers: {
        "Idempotency-Key": "client-abc",
        "X-Request-ID": "req-xyz",
      },
    });
    const key = resolveTradeIdempotencyKey(request, samplePayload);
    expect(key).toBe("idemp:client:client-abc:live");
  });

  test("uses X-Request-ID when Idempotency-Key is absent", () => {
    const request = new Request("http://internal/webhook", {
      method: "POST",
      headers: { "X-Request-ID": "req-xyz" },
    });
    const key = resolveTradeIdempotencyKey(request, samplePayload);
    expect(key).toBe("idemp:client:req-xyz:live");
  });

  test("falls back to fingerprint and splits live/test modes", () => {
    const request = new Request("http://internal/webhook", { method: "POST" });
    expect(resolveTradeIdempotencyKey(request, samplePayload)).toBe(
      "idemp:fp:binance:BTCUSDT:LONG:0.01:live"
    );
    expect(
      resolveTradeIdempotencyKey(request, { ...samplePayload, test: true })
    ).toBe("idemp:fp:binance:BTCUSDT:LONG:0.01:test");
  });

  test("client keys are mode-split", () => {
    const request = new Request("http://internal/webhook", {
      method: "POST",
      headers: { "Idempotency-Key": "k1" },
    });
    expect(
      resolveTradeIdempotencyKey(request, { ...samplePayload, test: true })
    ).toBe("idemp:client:k1:test");
  });
});

describe("resolveQueueIdempotencyKey", () => {
  test("prefers requestId when present", () => {
    expect(
      resolveQueueIdempotencyKey({
        requestId: "queue-req-1",
        ...samplePayload,
      })
    ).toBe("idemp:queue:queue-req-1");
  });

  test("falls back to fingerprint without requestId", () => {
    expect(resolveQueueIdempotencyKey(samplePayload)).toBe(
      "idemp:fp:binance:BTCUSDT:LONG:0.01:live"
    );
  });
});

describe("checkAndStoreIdempotency", () => {
  test("first call isNew true and stores key", async () => {
    const kv = createMockKv();
    const result = await checkAndStoreIdempotency(kv, "idemp:test:key-1");
    expect(result).toEqual({ isNew: true });
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(kv.store.has("idemp:test:key-1")).toBe(true);
  });

  test("second call same key isNew false", async () => {
    const kv = createMockKv();
    const first = await checkAndStoreIdempotency(kv, "idemp:test:key-2");
    const second = await checkAndStoreIdempotency(kv, "idemp:test:key-2");
    expect(first.isNew).toBe(true);
    expect(second).toEqual({ isNew: false });
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  test("missing KV is skipped (fail-open isNew true)", async () => {
    const result = await checkAndStoreIdempotency(undefined, "idemp:test:any");
    expect(result).toEqual({ isNew: true, skipped: true });
  });

  test("KV errors fail open with skipped", async () => {
    const kv = {
      get: vi.fn(async () => {
        throw new Error("kv unavailable");
      }),
      put: vi.fn(),
    } as unknown as KVNamespace;
    const result = await checkAndStoreIdempotency(kv, "idemp:test:err");
    expect(result).toEqual({ isNew: true, skipped: true });
  });
});
