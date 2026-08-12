/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, jest as vi } from "bun:test";
import {
  buildTradeFingerprint,
  checkAndStoreIdempotency,
  FP_TIME_BUCKET_MS,
  isIdempotencyKeyPresent,
  resolveQueueIdempotencyKey,
  resolveTradeIdempotencyKey,
  storeIdempotencyKey,
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

/** Fixed clock: minute bucket 28_333_333 (≈ 2024-era). */
const FIXED_NOW_MS = 28_333_333 * FP_TIME_BUCKET_MS;
const FIXED_BUCKET = Math.floor(FIXED_NOW_MS / FP_TIME_BUCKET_MS);

describe("buildTradeFingerprint", () => {
  test("includes per-minute time bucket", () => {
    expect(buildTradeFingerprint(samplePayload, FIXED_NOW_MS)).toBe(
      `idemp:fp:binance:BTCUSDT:LONG:0.01:live:${FIXED_BUCKET}`
    );
  });

  test("same minute yields same fingerprint (retries dedupe)", () => {
    const a = buildTradeFingerprint(samplePayload, FIXED_NOW_MS);
    const b = buildTradeFingerprint(
      samplePayload,
      FIXED_NOW_MS + FP_TIME_BUCKET_MS - 1
    );
    expect(a).toBe(b);
  });

  test("next minute yields different fingerprint (intentional repeats work)", () => {
    const first = buildTradeFingerprint(samplePayload, FIXED_NOW_MS);
    const next = buildTradeFingerprint(
      samplePayload,
      FIXED_NOW_MS + FP_TIME_BUCKET_MS
    );
    expect(first).not.toBe(next);
    expect(next).toBe(
      `idemp:fp:binance:BTCUSDT:LONG:0.01:live:${FIXED_BUCKET + 1}`
    );
  });
});

describe("resolveTradeIdempotencyKey", () => {
  test("prefers Idempotency-Key header over X-Request-ID and fingerprint", () => {
    const request = new Request("http://internal/webhook", {
      method: "POST",
      headers: {
        "Idempotency-Key": "client-abc",
        "X-Request-ID": "req-xyz",
      },
    });
    const key = resolveTradeIdempotencyKey(request, samplePayload, FIXED_NOW_MS);
    expect(key).toBe("idemp:client:client-abc:live");
  });

  test("uses X-Request-ID when Idempotency-Key is absent", () => {
    const request = new Request("http://internal/webhook", {
      method: "POST",
      headers: { "X-Request-ID": "req-xyz" },
    });
    const key = resolveTradeIdempotencyKey(request, samplePayload, FIXED_NOW_MS);
    expect(key).toBe("idemp:client:req-xyz:live");
  });

  test("falls back to fingerprint with time bucket and splits live/test modes", () => {
    const request = new Request("http://internal/webhook", { method: "POST" });
    expect(resolveTradeIdempotencyKey(request, samplePayload, FIXED_NOW_MS)).toBe(
      `idemp:fp:binance:BTCUSDT:LONG:0.01:live:${FIXED_BUCKET}`
    );
    expect(
      resolveTradeIdempotencyKey(
        request,
        { ...samplePayload, test: true },
        FIXED_NOW_MS
      )
    ).toBe(`idemp:fp:binance:BTCUSDT:LONG:0.01:test:${FIXED_BUCKET}`);
  });

  test("client keys are mode-split and not time-bucketed", () => {
    const request = new Request("http://internal/webhook", {
      method: "POST",
      headers: { "Idempotency-Key": "k1" },
    });
    expect(
      resolveTradeIdempotencyKey(
        request,
        { ...samplePayload, test: true },
        FIXED_NOW_MS
      )
    ).toBe("idemp:client:k1:test");
  });
});

describe("resolveQueueIdempotencyKey", () => {
  test("prefers gateway idempotencyKey over requestId", () => {
    expect(
      resolveQueueIdempotencyKey(
        {
          requestId: "queue-req-1",
          idempotencyKey: "idemp:client-key-abc:live",
          ...samplePayload,
        },
        FIXED_NOW_MS
      )
    ).toBe("idemp:client-key-abc:live");
  });

  test("prefers requestId when idempotencyKey absent", () => {
    expect(
      resolveQueueIdempotencyKey(
        {
          requestId: "queue-req-1",
          ...samplePayload,
        },
        FIXED_NOW_MS
      )
    ).toBe("idemp:queue:queue-req-1");
  });

  test("falls back to fingerprint with time bucket without requestId", () => {
    expect(resolveQueueIdempotencyKey(samplePayload, FIXED_NOW_MS)).toBe(
      `idemp:fp:binance:BTCUSDT:LONG:0.01:live:${FIXED_BUCKET}`
    );
  });
});

describe("isIdempotencyKeyPresent", () => {
  test("absent key is not present and does not store", async () => {
    const kv = createMockKv();
    const result = await isIdempotencyKeyPresent(kv, "idemp:test:absent");
    expect(result).toEqual({ present: false });
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.store.has("idemp:test:absent")).toBe(false);
  });

  test("present key returns present true without put", async () => {
    const kv = createMockKv(new Map([["idemp:test:present", "2026-01-01T00:00:00.000Z"]]));
    const result = await isIdempotencyKeyPresent(kv, "idemp:test:present");
    expect(result).toEqual({ present: true });
    expect(kv.put).not.toHaveBeenCalled();
  });

  test("missing KV is skipped (fail-open present false)", async () => {
    const result = await isIdempotencyKeyPresent(undefined, "idemp:test:any");
    expect(result).toEqual({ present: false, skipped: true });
  });

  test("KV get errors fail open with skipped", async () => {
    const kv = {
      get: vi.fn(async () => {
        throw new Error("kv unavailable");
      }),
      put: vi.fn(),
    } as unknown as KVNamespace;
    const result = await isIdempotencyKeyPresent(kv, "idemp:test:err");
    expect(result).toEqual({ present: false, skipped: true });
  });
});

describe("storeIdempotencyKey", () => {
  test("stores key with put only (queue success path)", async () => {
    const kv = createMockKv();
    const result = await storeIdempotencyKey(kv, "idemp:test:store-1");
    expect(result).toEqual({ stored: true });
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.store.has("idemp:test:store-1")).toBe(true);
  });

  test("missing KV is skipped (stored false)", async () => {
    const result = await storeIdempotencyKey(undefined, "idemp:test:any");
    expect(result).toEqual({ stored: false, skipped: true });
  });

  test("KV put errors fail open with skipped", async () => {
    const kv = {
      get: vi.fn(),
      put: vi.fn(async () => {
        throw new Error("kv put failed");
      }),
    } as unknown as KVNamespace;
    const result = await storeIdempotencyKey(kv, "idemp:test:err");
    expect(result).toEqual({ stored: false, skipped: true });
  });

  test("queue path: present check then store only after success (helper composition)", async () => {
    // Mirrors executeTradeFromQueue: check → execute → store on success only.
    const kv = createMockKv();
    const key = "idemp:queue:req-retry";

    // First attempt: not present, execute fails → do NOT store
    const beforeFail = await isIdempotencyKeyPresent(kv, key);
    expect(beforeFail).toEqual({ present: false });
    // simulate execute failure: skip store
    expect(kv.store.has(key)).toBe(false);

    // Retry after failure: still not present, can re-execute
    const beforeRetry = await isIdempotencyKeyPresent(kv, key);
    expect(beforeRetry).toEqual({ present: false });

    // Success path: store after success
    const store = await storeIdempotencyKey(kv, key);
    expect(store).toEqual({ stored: true });

    // Subsequent redelivery: present → dedupe without re-execute
    const afterSuccess = await isIdempotencyKeyPresent(kv, key);
    expect(afterSuccess).toEqual({ present: true });
  });
});

/**
 * HTTP path (/webhook, /process) and queue path share the same semantics:
 * isIdempotencyKeyPresent before execute → storeIdempotencyKey only after success.
 * Race note: concurrent in-flight requests with the same key may both pass the
 * check and double-hit the exchange; gateway DO is the primary gate.
 */
describe("HTTP path: check without store → execute → store on success", () => {
  test("failed execute leaves key absent so retries are allowed", async () => {
    const kv = createMockKv();
    const key = "idemp:client:http-retry:live";

    const beforeFail = await isIdempotencyKeyPresent(kv, key);
    expect(beforeFail).toEqual({ present: false });
    // simulate execute failure: do NOT store
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.store.has(key)).toBe(false);

    // Retry after failure: still not present, can re-execute
    const beforeRetry = await isIdempotencyKeyPresent(kv, key);
    expect(beforeRetry).toEqual({ present: false });
  });

  test("success stores key; subsequent request is present (409 path)", async () => {
    const kv = createMockKv();
    const key = "idemp:client:http-ok:live";

    const before = await isIdempotencyKeyPresent(kv, key);
    expect(before).toEqual({ present: false });

    const store = await storeIdempotencyKey(kv, key);
    expect(store).toEqual({ stored: true });

    const afterSuccess = await isIdempotencyKeyPresent(kv, key);
    expect(afterSuccess).toEqual({ present: true });
  });
});

describe("checkAndStoreIdempotency (legacy helper)", () => {
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
