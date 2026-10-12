/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the two defensive `safeWaitUntil` onError callbacks in
 * src/execution.ts that are UNREACHABLE with real dependencies:
 *
 * - execution.ts:208-210 — `Promise.all([tradeWrite, posWrite])` can
 *   never reject in production because both inputs already have
 *   `.catch` handlers attached. The mock below returns a thenable
 *   whose `.catch` yields a rejecting promise, simulating an
 *   "impossible" background-write loss so the callback executes.
 * - execution.ts:627 — `sendTradeNotificationToTelegram` catches
 *   everything internally and never rejects. The notifications module
 *   mock below makes it reject so the callback executes.
 *
 * `mock.module` must run before `../src/execution` is evaluated, so
 * this file uses dynamic imports (top-level await) instead of static
 * imports for the modules under test.
 *
 * The service-bindings mock DELEGATES to the real module for everything
 * except the flag above. A hand-written mirror rotted before (it missed
 * the `internalKey` option agent-style callers pass), leaking
 * "auth key not configured" rejections into unrelated suites in the
 * same process. Delegation keeps the mock faithful by construction.
 */

import { describe, expect, it, mock, spyOn, afterAll } from "bun:test";
import { KVKeys } from "@hoox-sh/hoox-shared/kvKeys";

// --- Real-module snapshots (before mock.module below) ---
//
// Spread snapshots evaluated NOW: module namespaces resolve live, so a
// bare namespace reference (or a lazy spread inside the mock factory)
// would read back mock values once mock.module is registered.

const realBindings = {
  ...(await import("@hoox-sh/hoox-shared/service-bindings")),
};
const realNotifications = { ...(await import("../src/notifications")) };

// --- Module mocks (must be registered before dynamic imports below) ---

const controls = {
  /** When true, D1 writes return a thenable whose .catch rejects. */
  rejectBackgroundWrites: false,
};

mock.module("@hoox-sh/hoox-shared/service-bindings", () => ({
  ...realBindings,
  authenticatedServiceFetch: (
    binding: never,
    env: never,
    path: string,
    body?: unknown,
    options?: Record<string, unknown>
  ) => {
    if (controls.rejectBackgroundWrites) {
      // Simulate the "impossible" case: the write promise rejects
      // even after production's `.catch` is attached.
      return {
        catch: () => Promise.reject(new Error("background write lost")),
      };
    }
    return (
      realBindings.authenticatedServiceFetch as (
        ...a: unknown[]
      ) => Promise<Response>
    )(binding, env, path, body, options);
  },
}));

mock.module("../src/notifications", () => ({
  ...realNotifications,
  sendTradeNotificationToTelegram: async () => {
    throw new Error("telegram down");
  },
}));

afterAll(() => {
  // Belt and suspenders: re-register the real snapshots so that even if
  // this file's mocks leak process-wide (mock.restore() cannot undo
  // mock.module), later suites resolve working implementations.
  mock.module("@hoox-sh/hoox-shared/service-bindings", () => realBindings);
  mock.module("../src/notifications", () => realNotifications);
});

// Dynamic imports — evaluated AFTER the mocks above are registered.
const { executeTrade, updateD1TradeRecords } = await import("../src/execution");
const { ExchangeRouter } = await import("../src/exchange-router");

// --- Tests ---

function makeCtx() {
  const seen: Promise<unknown>[] = [];
  return {
    seen,
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        seen.push(p);
        return p;
      },
    } as unknown as ExecutionContext,
  };
}

describe("execution.ts defensive background callbacks", () => {
  it("invokes the D1 safeWaitUntil onError when background writes are lost", async () => {
    controls.rejectBackgroundWrites = true;
    try {
      const d1 = {
        fetch: async () =>
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
      } as unknown as Fetcher;
      const { ctx, seen } = makeCtx();
      // Must not throw: safeWaitUntil swallows the rejection via onError.
      await updateD1TradeRecords(
        { D1_SERVICE: d1, INTERNAL_KEY_BINDING: "k" },
        { orderId: "1" },
        {
          exchange: "binance",
          action: "LONG",
          symbol: "BTCUSDT",
          quantity: 0.01,
        },
        "binance",
        undefined,
        ctx
      );
      expect(seen).toHaveLength(1);
      await seen[0];
    } finally {
      controls.rejectBackgroundWrites = false;
    }
  });

  it("invokes the telegram safeWaitUntil onError when notify rejects", async () => {
    const client = {
      getAccountInfo: async () => ({}),
      getPositions: async () => [],
      openLong: async () => ({ orderId: "x" }),
      openShort: async () => ({ orderId: "x" }),
      closeLong: async () => ({ orderId: "x" }),
      closeShort: async () => ({ orderId: "x" }),
    };
    const routeSpy = spyOn(ExchangeRouter.prototype, "route").mockResolvedValue(
      {
        client,
        exchange: "binance",
        useWebsocketDO: false,
        testnet: false,
      } as never
    );
    try {
      const { ctx, seen } = makeCtx();
      const dbLogger = {
        logRequest: async () => "id",
        logResponse: async () => undefined,
        logTrade: async () => undefined,
      };
      const env = {
        CONFIG_KV: {
          get: async (key: string) =>
            key === KVKeys.KV_TRADE_KILL_SWITCH ||
            key === KVKeys.KV_GLOBAL_KILL_SWITCH
              ? null
              : null,
        },
        TELEGRAM_SERVICE: {
          fetch: async () =>
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
        },
        TELEGRAM_INTERNAL_KEY_BINDING: "tg-key",
        INTERNAL_KEY_BINDING: "k",
      } as never;
      const r = await executeTrade(
        {
          exchange: "binance",
          action: "LONG",
          symbol: "BTCUSDT",
          quantity: 0.01,
        },
        env,
        dbLogger as never,
        Date.now(),
        "log-1",
        ctx
      );
      // Trade itself succeeds; only the background notify fails.
      expect(r.success).toBe(true);
      for (const p of seen) {
        await p;
      }
    } finally {
      routeSpy.mockRestore();
    }
  });
});
