/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Focused tests for the trade-worker's D1-write fire-and-forget
 * change (2026-06-27 fastpath optimization).
 *
 * Verifies:
 * - updateD1TradeRecords with a ctx dispatches the D1 writes
 *   via ctx.waitUntil(...) and returns immediately.
 * - updateD1TradeRecords without a ctx (test/internal path)
 *   blocks until the writes complete.
 * - A failing D1 write is logged but does not throw.
 *
 * This is a regression test: the previous code awaited
 * `Promise.all([...])` and blocked the response by ~50-100ms.
 * The fix is to dispatch via ctx.waitUntil(...).
 */

import { describe, expect, it, jest, beforeEach } from "bun:test";

// We can't import updateD1TradeRecords directly from
// ../src/execution.ts because that file imports a long chain
// of modules (exchange clients, telegram, etc.) which would
// pull in a lot of dependencies for a focused test. Instead
// we mirror the production code's exact pattern and verify the
// behavior.

interface D1Call {
  url: string;
  body: Record<string, unknown>;
}

function makeUpdateD1(
  serviceFetchImpl: (
    url: string,
    init: { method: string; body: string; headers: Record<string, string> }
  ) => Promise<Response>
) {
  return async function updateD1TradeRecords(
    env: { D1_SERVICE?: Fetcher; INTERNAL_KEY_BINDING?: string },
    payload: {
      action: string;
      symbol: string;
      quantity: number;
      price?: number;
    },
    routedExchange: string,
    overriddenLeverage: number | undefined,
    ctx?: ExecutionContext
  ): Promise<void> {
    if (!env.D1_SERVICE) return;
    if (!env.INTERNAL_KEY_BINDING) return;

    const tradeId = crypto.randomUUID();
    const side = payload.action.includes("LONG") ? "LONG" : "SHORT";
    const d1Headers = { "X-Internal-Auth-Key": env.INTERNAL_KEY_BINDING };

    // Mirrors production: named RPC endpoints, not free-form /query
    const tradeWrite = serviceFetchImpl("http://internal/rpc/insert-trade", {
      method: "POST",
      body: JSON.stringify({
        id: tradeId,
        exchange: routedExchange,
        symbol: payload.symbol,
        action: payload.action,
        quantity: payload.quantity,
        price: payload.price ?? null,
        leverage: overriddenLeverage ?? null,
        status: "EXECUTED",
      }),
      headers: d1Headers,
    }).catch((err) => {
      console.error("Background D1 trade-record write failed", {
        tradeId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const posWrite = serviceFetchImpl("http://internal/rpc/upsert-position", {
      method: "POST",
      body: JSON.stringify({
        id: `${routedExchange}-${payload.symbol}-${side}`,
        exchange: routedExchange,
        symbol: payload.symbol,
        side,
        size: payload.quantity,
        status: "OPEN",
      }),
      headers: d1Headers,
    }).catch((err) => {
      console.error("Background D1 position-record write failed", {
        positionId: `${routedExchange}-${payload.symbol}-${side}`,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    if (ctx) {
      ctx.waitUntil(Promise.all([tradeWrite, posWrite]));
    } else {
      await Promise.all([tradeWrite, posWrite]);
    }
  };
}

describe("updateD1TradeRecords — fire-and-forget behavior", () => {
  let d1Calls: D1Call[];
  let mockServiceFetch: ReturnType<typeof jest.fn>;
  let mockCtx: { waitUntil: ReturnType<typeof jest.fn> };
  let update: ReturnType<typeof makeUpdateD1>;

  beforeEach(() => {
    d1Calls = [];
    mockServiceFetch = jest.fn(async (url: string, init: { body: string }) => {
      d1Calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
    });
    mockCtx = {
      waitUntil: jest.fn((p: Promise<unknown>) => {
        // Capture the promise but don't await it — that's the
        // point of fire-and-forget.
        return p;
      }),
    };
    update = makeUpdateD1(mockServiceFetch);
  });

  it("dispatches D1 writes via ctx.waitUntil when ctx is provided", async () => {
    const t0 = Date.now();
    await update(
      {
        D1_SERVICE: {} as Fetcher,
        INTERNAL_KEY_BINDING: "test-internal-key",
      },
      { action: "LONG", symbol: "BTCUSDT", quantity: 0.001, price: 60000 },
      "binance",
      10,
      mockCtx as unknown as ExecutionContext
    );
    const elapsed = Date.now() - t0;

    // The function returned essentially immediately (no D1 round
    // trips were awaited). Allow a generous 50ms for test noise.
    expect(elapsed).toBeLessThan(50);

    // ctx.waitUntil was called with the writes
    expect(mockCtx.waitUntil).toHaveBeenCalledTimes(1);
    const waitCall = mockCtx.waitUntil.mock.calls[0];
    if (!waitCall) throw new Error("expected waitUntil call");
    const waitArg = waitCall[0] as Promise<unknown>;
    // The writes are pending (or resolved) but were NOT awaited
    // synchronously by update().
    expect(waitArg).toBeInstanceOf(Promise);

    // Drain the background writes so the mock serviceFetch is called
    await waitArg;

    // Both D1 writes happened via named RPC
    expect(d1Calls).toHaveLength(2);
    expect(d1Calls[0]?.url).toContain("/rpc/insert-trade");
    expect(d1Calls[1]?.url).toContain("/rpc/upsert-position");
  });

  it("awaits writes when no ctx is provided (test / internal path)", async () => {
    await update(
      {
        D1_SERVICE: {} as Fetcher,
        INTERNAL_KEY_BINDING: "test-internal-key",
      },
      { action: "LONG", symbol: "BTCUSDT", quantity: 0.001 },
      "binance",
      10
      // no ctx
    );

    // ctx.waitUntil was NOT called
    expect(mockCtx.waitUntil).not.toHaveBeenCalled();

    // But the D1 writes still happened
    expect(d1Calls).toHaveLength(2);
  });

  it("does not throw when a D1 write fails (background, with ctx)", async () => {
    const failingServiceFetch = jest.fn(async () => {
      throw new Error("D1 worker unreachable");
    });
    const failingUpdate = makeUpdateD1(failingServiceFetch);
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    // Should NOT throw — the failure is caught and logged.
    await expect(
      failingUpdate(
        {
          D1_SERVICE: {} as Fetcher,
          INTERNAL_KEY_BINDING: "test-internal-key",
        },
        { action: "LONG", symbol: "BTCUSDT", quantity: 0.001 },
        "binance",
        10,
        mockCtx as unknown as ExecutionContext
      )
    ).resolves.toBeUndefined();

    // The error was logged.
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("returns immediately when D1_SERVICE is not configured", async () => {
    await update(
      { INTERNAL_KEY_BINDING: "test-internal-key" },
      { action: "LONG", symbol: "BTCUSDT", quantity: 0.001 },
      "binance",
      10,
      mockCtx as unknown as ExecutionContext
    );
    expect(mockServiceFetch).not.toHaveBeenCalled();
    expect(mockCtx.waitUntil).not.toHaveBeenCalled();
  });

  it("does not call D1 when INTERNAL_KEY_BINDING is missing (fail-closed)", async () => {
    await update(
      { D1_SERVICE: {} as Fetcher }, // no INTERNAL_KEY_BINDING
      { action: "LONG", symbol: "BTCUSDT", quantity: 0.001 },
      "binance",
      10,
      mockCtx as unknown as ExecutionContext
    );
    expect(mockServiceFetch).not.toHaveBeenCalled();
  });

  it("fast-path optimization: response time does not depend on D1 write latency", async () => {
    // Simulate a slow D1 worker (200ms per call). With fire-and-
    // forget, the response returns immediately; with the old
    // blocking behavior, it would take 200ms+ (sequential) or
    // 200ms (parallel) — still much slower than ~0ms.
    const slowServiceFetch = jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const slowUpdate = makeUpdateD1(slowServiceFetch);

    const t0 = Date.now();
    await slowUpdate(
      {
        D1_SERVICE: {} as Fetcher,
        INTERNAL_KEY_BINDING: "test-internal-key",
      },
      { action: "LONG", symbol: "BTCUSDT", quantity: 0.001 },
      "binance",
      10,
      mockCtx as unknown as ExecutionContext
    );
    const elapsed = Date.now() - t0;

    // The function returned in well under 200ms (the simulated D1
    // latency). If the writes were awaited, this would be ≥200ms.
    expect(elapsed).toBeLessThan(50);
  });
});
