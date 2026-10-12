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
 * imports for the modules under test. Keep these mock-behavior tests
 * isolated here — the mocks are file-scoped.
 */

import { describe, expect, it, mock, spyOn } from "bun:test";
import { KVKeys } from "@hoox-sh/hoox-shared/kvKeys";

// --- Module mocks (must be registered before dynamic imports below) ---

const controls = {
  /** When true, D1 writes return a thenable whose .catch rejects. */
  rejectBackgroundWrites: false,
};

mock.module("@hoox-sh/hoox-shared/service-bindings", () => {
  // Faithful-enough mirror of the real module's auth-key plumbing.
  // Values match packages/shared/src/service-bindings.ts.
  const pick = (
    env: Record<string, unknown>,
    fields: string | readonly string[]
  ): string | undefined => {
    const list = Array.isArray(fields) ? fields : [fields];
    for (const f of list) {
      const v = env[f];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };
  const ALL_FIELDS = {
    InternalAuthKeyFields: {
      DEFAULT: "INTERNAL_KEY_BINDING",
      D1_READ: "D1_READ_KEY_BINDING",
      D1_WRITE: "D1_WRITE_KEY_BINDING",
      TRADE_EXECUTE: "TRADE_EXECUTE_KEY_BINDING",
      TRADE_READ: "TRADE_READ_KEY_BINDING",
      TELEGRAM_ALERT: "TELEGRAM_INTERNAL_KEY_BINDING",
      WALLET_EXECUTE: "WALLET_EXECUTE_KEY_BINDING",
      AGENT: "AGENT_INTERNAL_KEY",
      D1_INTERNAL_ALIAS: "D1_INTERNAL_KEY",
      TRADE_INTERNAL_ALIAS: "TRADE_INTERNAL_KEY",
      TELEGRAM_INTERNAL_ALIAS: "TELEGRAM_INTERNAL_KEY",
    },
    D1_READ_AUTH_KEY_FIELDS: ["D1_READ_KEY_BINDING", "INTERNAL_KEY_BINDING"],
    D1_WRITE_AUTH_KEY_FIELDS: ["D1_WRITE_KEY_BINDING", "INTERNAL_KEY_BINDING"],
    TRADE_EXECUTE_AUTH_KEY_FIELDS: [
      "TRADE_EXECUTE_KEY_BINDING",
      "INTERNAL_KEY_BINDING",
      "AGENT_INTERNAL_KEY",
    ],
    TRADE_READ_AUTH_KEY_FIELDS: [
      "TRADE_READ_KEY_BINDING",
      "INTERNAL_KEY_BINDING",
    ],
    TELEGRAM_ALERT_AUTH_KEY_FIELDS: [
      "TELEGRAM_INTERNAL_KEY_BINDING",
      "INTERNAL_KEY_BINDING",
    ],
    WALLET_EXECUTE_AUTH_KEY_FIELDS: [
      "WALLET_EXECUTE_KEY_BINDING",
      "INTERNAL_KEY_BINDING",
    ],
    DASHBOARD_D1_READ_AUTH_KEY_FIELDS: [
      "D1_READ_KEY_BINDING",
      "D1_INTERNAL_KEY",
      "INTERNAL_KEY_BINDING",
    ],
    DASHBOARD_TRADE_EXECUTE_AUTH_KEY_FIELDS: [
      "TRADE_EXECUTE_KEY_BINDING",
      "TRADE_INTERNAL_KEY",
      "INTERNAL_KEY_BINDING",
    ],
    DASHBOARD_TELEGRAM_ALERT_AUTH_KEY_FIELDS: [
      "TELEGRAM_INTERNAL_KEY_BINDING",
      "TELEGRAM_INTERNAL_KEY",
      "INTERNAL_KEY_BINDING",
    ],
  };
  return {
    ...ALL_FIELDS,
    ServiceAuthError: class ServiceAuthError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ServiceAuthError";
      }
    },
    resolveInternalAuthKey: (
      env: Record<string, unknown>,
      keyFields: string | readonly string[]
    ) => pick(env, keyFields),
    serviceFetch: (
      binding: { fetch: typeof fetch },
      path: string,
      body?: unknown
    ) =>
      binding.fetch(`http://internal${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body != null ? JSON.stringify(body) : undefined,
      }),
    authenticatedServiceFetch: (
      binding: { fetch: typeof fetch },
      env: Record<string, unknown>,
      path: string,
      body?: unknown,
      options?: { internalKeyFields?: string | readonly string[] }
    ) => {
      if (controls.rejectBackgroundWrites) {
        // Simulate the "impossible" case: the write promise rejects
        // even after production's `.catch` is attached.
        return {
          catch: () => Promise.reject(new Error("background write lost")),
        };
      }
      const key = options?.internalKeyFields
        ? pick(env, options.internalKeyFields)
        : (env["INTERNAL_KEY_BINDING"] as string | undefined);
      if (!key) return Promise.reject(new Error("auth key not configured"));
      return binding.fetch(`http://internal${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": key,
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });
    },
  };
});

mock.module("../src/notifications", () => ({
  sendTradeNotificationToTelegram: async () => {
    throw new Error("telegram down");
  },
}));

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
