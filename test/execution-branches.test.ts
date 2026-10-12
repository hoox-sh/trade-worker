/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Branch coverage for workers/trade-worker/src/execution.ts.
 *
 * Unlike test/d1-fire-and-forget.test.ts (which mirrors the D1-write
 * pattern against a local reimplementation), every test here imports
 * the REAL module so lines in src/execution.ts are actually executed.
 * All I/O is mocked (bun:test fns, in-memory KV, stub service
 * bindings) — no live network.
 *
 * Covered branches:
 * - updateD1TradeRecords: per-write .catch handlers, with-ctx
 *   (safeWaitUntil) vs no-ctx (await) paths, fail-closed without a
 *   D1 write key, testnet ledger vocabulary.
 * - validateTradePayload: over-long exchange, bad symbol, non-boolean
 *   test flag.
 * - executeTrade: kill-switch fail-closed (missing_kv / read_error /
 *   active), malformed + valid risk-knob KV parsing, risk-fetch
 *   fail-open, max-position-size rejection, route failure, testnet
 *   credential-source logging, WS-DO path (success + failure),
 *   missing REST client, CLOSE_* actions, leverage-set failure,
 *   dbLogger failure inside the catch path, telegram notification.
 */

import { describe, expect, it, spyOn, beforeEach, afterEach } from "bun:test";
import { KVKeys } from "@hoox-sh/hoox-shared/kvKeys";
import {
  executeTrade,
  updateD1TradeRecords,
  validateApiCredentials,
  validateTradePayload,
} from "../src/execution";
import { ExchangeRouter } from "../src/exchange-router";
import type { WebhookPayload } from "@hoox-sh/hoox-shared/types";

// --- Helpers ---

function makeClient() {
  return {
    getAccountInfo: async () => ({}),
    getPositions: async () => [],
    setLeverage: async (_symbol: string, _lev: number) => {},
    openLong: async (symbol: string, quantity: number) => ({
      orderId: `long-${symbol}-${quantity}`,
    }),
    openShort: async (symbol: string, quantity: number) => ({
      orderId: `short-${symbol}-${quantity}`,
    }),
    closeLong: async (symbol: string, quantity: number) => ({
      orderId: `closelong-${symbol}-${quantity}`,
    }),
    closeShort: async (symbol: string, quantity: number) => ({
      orderId: `closeshort-${symbol}-${quantity}`,
    }),
  };
}

type MockClient = ReturnType<typeof makeClient>;

function makeDbLogger() {
  return {
    logRequest: async () => "db-log-id",
    logResponse: async () => undefined,
    logTrade: async () => undefined,
  };
}

function makeCtx() {
  const seen: Promise<unknown>[] = [];
  return {
    seen,
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        seen.push(p);
        return p;
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  };
}

/** In-memory CONFIG_KV. Values absent from `values` read as null. */
function makeKv(
  values: Record<string, string> = {},
  opts: { throwOn?: string[]; throwAll?: boolean } = {}
) {
  return {
    get: async (key: string): Promise<string | null> => {
      if (opts.throwAll || opts.throwOn?.includes(key)) {
        throw new Error(`KV boom on ${key}`);
      }
      return values[key] ?? null;
    },
  };
}

function makeD1Service(
  impl?: (url: string, init?: RequestInit) => Promise<Response>
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (
    url: string,
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({ url, init });
    if (impl) return impl(url, init);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  return { calls, binding: { fetch: fetchFn } as unknown as Fetcher };
}

const basePayload: WebhookPayload = {
  exchange: "binance",
  action: "LONG",
  symbol: "BTCUSDT",
  quantity: 0.01,
};

function baseEnv(extra: Record<string, unknown> = {}) {
  return {
    CONFIG_KV: makeKv(),
    INTERNAL_KEY_BINDING: "test-internal-key",
    ...extra,
  } as unknown as Parameters<typeof executeTrade>[1];
}

// --- validateTradePayload edge branches ---

describe("validateTradePayload - uncovered branches", () => {
  it("rejects an exchange id longer than 32 chars", () => {
    const r = validateTradePayload({
      ...basePayload,
      exchange: "x".repeat(33),
    });
    expect(r.isValid).toBe(false);
    expect(r.error).toBe("Invalid exchange in payload");
  });

  it("rejects an empty symbol as missing", () => {
    const r = validateTradePayload({ ...basePayload, symbol: "" });
    expect(r.isValid).toBe(false);
    expect(r.error).toBe("Missing required fields in payload");
  });

  it("rejects a non-string symbol", () => {
    const r = validateTradePayload({ ...basePayload, symbol: 123 as never });
    expect(r.isValid).toBe(false);
    expect(r.error).toBe("Invalid symbol in payload");
  });

  it("rejects an over-long symbol", () => {
    const r = validateTradePayload({
      ...basePayload,
      symbol: "X".repeat(33),
    });
    expect(r.isValid).toBe(false);
    expect(r.error).toBe("Invalid symbol in payload");
  });

  it("rejects a non-boolean test flag", () => {
    const r = validateTradePayload({ ...basePayload, test: "yes" as never });
    expect(r.isValid).toBe(false);
    expect(r.error).toBe("Invalid test flag in payload");
  });

  it("accepts a valid payload with test flag", () => {
    expect(validateTradePayload({ ...basePayload, test: true }).isValid).toBe(
      true
    );
  });
});

describe("validateApiCredentials - dex branch", () => {
  it("requires WEB3_WALLET_SERVICE for dex venues", () => {
    expect(validateApiCredentials("uniswap-ethereum", {} as never)).toBe(false);
    expect(
      validateApiCredentials("uniswap-ethereum", {
        WEB3_WALLET_SERVICE: {} as Fetcher,
      }).valueOf()
    ).toBe(true);
  });
});

// --- updateD1TradeRecords (real implementation) ---

describe("updateD1TradeRecords - real implementation", () => {
  it("dispatches both writes via ctx.waitUntil when ctx is provided", async () => {
    const d1 = makeD1Service();
    const { ctx, seen } = makeCtx();
    await updateD1TradeRecords(
      {
        D1_SERVICE: d1.binding,
        INTERNAL_KEY_BINDING: "k",
      },
      { orderId: "1" },
      { ...basePayload },
      "binance",
      10,
      ctx
    );
    expect(seen).toHaveLength(1);
    await seen[0];
    expect(d1.calls).toHaveLength(2);
    expect(d1.calls[0]?.url).toContain("/rpc/insert-trade");
    expect(d1.calls[1]?.url).toContain("/rpc/upsert-position");
    const tradeBody = JSON.parse(
      (d1.calls[0]?.init?.body as string) ?? "{}"
    ) as Record<string, unknown>;
    expect(tradeBody["status"]).toBe("EXECUTED");
    expect(tradeBody["leverage"]).toBe(10);
  });

  it("awaits writes when no ctx is provided", async () => {
    const d1 = makeD1Service();
    await updateD1TradeRecords(
      { D1_SERVICE: d1.binding, INTERNAL_KEY_BINDING: "k" },
      { orderId: "1" },
      { ...basePayload },
      "binance",
      undefined
    );
    expect(d1.calls).toHaveLength(2);
  });

  it("logs but does not throw when the trade write fails", async () => {
    const d1 = makeD1Service(async (url) => {
      if (url.includes("/rpc/insert-trade")) {
        throw new Error("D1 trade write down");
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    await expect(
      updateD1TradeRecords(
        { D1_SERVICE: d1.binding, INTERNAL_KEY_BINDING: "k" },
        { orderId: "1" },
        { ...basePayload },
        "binance",
        undefined
      )
    ).resolves.toBeUndefined();
    expect(d1.calls).toHaveLength(2);
  });

  it("logs but does not throw when the position write fails", async () => {
    const d1 = makeD1Service(async (url) => {
      if (url.includes("/rpc/upsert-position")) {
        throw new Error("D1 position write down");
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    await expect(
      updateD1TradeRecords(
        { D1_SERVICE: d1.binding, INTERNAL_KEY_BINDING: "k" },
        { orderId: "1" },
        { ...basePayload },
        "binance",
        undefined
      )
    ).resolves.toBeUndefined();
    expect(d1.calls).toHaveLength(2);
  });

  it("returns early without a D1 write key (fail-closed)", async () => {
    const d1 = makeD1Service();
    await updateD1TradeRecords(
      { D1_SERVICE: d1.binding },
      { orderId: "1" },
      { ...basePayload },
      "binance",
      undefined
    );
    expect(d1.calls).toHaveLength(0);
  });

  it("uses TEST_EXECUTED + testnet position id for test payloads", async () => {
    const d1 = makeD1Service();
    await updateD1TradeRecords(
      { D1_SERVICE: d1.binding, INTERNAL_KEY_BINDING: "k" },
      { orderId: "1" },
      { ...basePayload, test: true },
      "binance",
      undefined
    );
    const tradeBody = JSON.parse(
      (d1.calls[0]?.init?.body as string) ?? "{}"
    ) as Record<string, unknown>;
    const posBody = JSON.parse(
      (d1.calls[1]?.init?.body as string) ?? "{}"
    ) as Record<string, unknown>;
    expect(tradeBody["status"]).toBe("TEST_EXECUTED");
    expect(posBody["id"]).toBe("binance-testnet-BTCUSDT-LONG");
    expect(posBody["status"]).toBe("OPEN");
  });

  it("writes CLOSED status with zero size for CLOSE actions", async () => {
    const d1 = makeD1Service();
    await updateD1TradeRecords(
      { D1_SERVICE: d1.binding, INTERNAL_KEY_BINDING: "k" },
      { orderId: "1" },
      { ...basePayload, action: "CLOSE_LONG" },
      "binance",
      undefined
    );
    const posBody = JSON.parse(
      (d1.calls[1]?.init?.body as string) ?? "{}"
    ) as Record<string, unknown>;
    expect(posBody["status"]).toBe("CLOSED");
    expect(posBody["size"]).toBe(0);
  });
});

// --- executeTrade ---

describe("executeTrade - kill switch branches", () => {
  let routeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    routeSpy = spyOn(ExchangeRouter.prototype, "route").mockResolvedValue({
      client: makeClient() as unknown as MockClient & never,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: false,
    } as never);
  });

  afterEach(() => {
    routeSpy.mockRestore();
  });

  it("halts when CONFIG_KV is missing (missing_kv fail-closed)", async () => {
    const { ctx } = makeCtx();
    const dbLogger = makeDbLogger();
    const env = baseEnv();
    delete (env as unknown as Record<string, unknown>)["CONFIG_KV"];
    const r = await executeTrade(
      { ...basePayload },
      env,
      dbLogger as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toContain("KILL_SWITCH_ACTIVE");
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it("halts when kill-switch KV read fails (read_error fail-closed)", async () => {
    const { ctx } = makeCtx();
    const dbLogger = makeDbLogger();
    const r = await executeTrade(
      { ...basePayload },
      baseEnv({ CONFIG_KV: makeKv({}, { throwAll: true }) }),
      dbLogger as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toContain("KILL_SWITCH_ACTIVE");
  });

  it("halts when the kill switch flag is set", async () => {
    const { ctx } = makeCtx();
    const dbLogger = makeDbLogger();
    const r = await executeTrade(
      { ...basePayload },
      baseEnv({
        CONFIG_KV: makeKv({ [KVKeys.KV_TRADE_KILL_SWITCH]: "true" }),
      }),
      dbLogger as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toContain("KILL_SWITCH_ACTIVE");
    expect(routeSpy).not.toHaveBeenCalled();
  });
});

describe("executeTrade - risk knob branches", () => {
  let routeSpy: ReturnType<typeof spyOn>;
  let client: MockClient;

  beforeEach(() => {
    client = makeClient();
    const c = client;
    routeSpy = spyOn(ExchangeRouter.prototype, "route").mockImplementation(
      async () =>
        ({
          client: c,
          exchange: "binance",
          useWebsocketDO: false,
          testnet: false,
        }) as never
    );
  });

  afterEach(() => {
    routeSpy.mockRestore();
  });

  it("applies a valid default leverage from KV", async () => {
    const setLev: { symbol: string; lev: number }[] = [];
    client.setLeverage = async (symbol: string, lev: number) => {
      setLev.push({ symbol, lev });
    };
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload },
      baseEnv({
        CONFIG_KV: makeKv({ [KVKeys.KV_TRADE_DEFAULT_LEVERAGE]: "5" }),
      }),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
    expect(setLev).toEqual([{ symbol: "BTCUSDT", lev: 5 }]);
  });

  it("ignores malformed default leverage and still executes", async () => {
    const setLev: number[] = [];
    client.setLeverage = async (_s: string, lev: number) => {
      setLev.push(lev);
    };
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload },
      baseEnv({
        CONFIG_KV: makeKv({ [KVKeys.KV_TRADE_DEFAULT_LEVERAGE]: "abc" }),
      }),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
    expect(setLev).toEqual([]);
  });

  it("does not override explicit payload leverage with the KV default", async () => {
    const setLev: number[] = [];
    client.setLeverage = async (_s: string, lev: number) => {
      setLev.push(lev);
    };
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload, leverage: 20 },
      baseEnv({
        CONFIG_KV: makeKv({ [KVKeys.KV_TRADE_DEFAULT_LEVERAGE]: "5" }),
      }),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
    expect(setLev).toEqual([20]);
  });

  it("ignores malformed max position size and still executes", async () => {
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload },
      baseEnv({
        CONFIG_KV: makeKv({ [KVKeys.KV_TRADE_MAX_POSITION_SIZE]: "huge!" }),
      }),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
  });

  it("rejects quantities above a valid max position size", async () => {
    const { ctx } = makeCtx();
    const dbLogger = makeDbLogger();
    const logSpy = spyOn(dbLogger, "logResponse");
    const r = await executeTrade(
      { ...basePayload, quantity: 10 },
      baseEnv({
        CONFIG_KV: makeKv({ [KVKeys.KV_TRADE_MAX_POSITION_SIZE]: "0.5" }),
      }),
      dbLogger as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toContain("exceeds maximum allowed size");
    expect(routeSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it("fails open when risk KV reads throw (kill switch still passes)", async () => {
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload },
      baseEnv({
        CONFIG_KV: makeKv(
          {},
          {
            throwOn: [
              KVKeys.KV_TRADE_DEFAULT_LEVERAGE,
              KVKeys.KV_TRADE_MAX_POSITION_SIZE,
            ],
          }
        ),
      }),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
  });
});

describe("executeTrade - routing and action branches", () => {
  let routeSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    routeSpy?.mockRestore();
  });

  function mockRoute(result: unknown) {
    routeSpy = spyOn(ExchangeRouter.prototype, "route").mockResolvedValue(
      result as never
    );
  }

  it("returns 400 when routing fails", async () => {
    routeSpy = spyOn(ExchangeRouter.prototype, "route").mockRejectedValue(
      new Error("TEST_TRADING_UNSUPPORTED")
    );
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload, test: true },
      baseEnv(),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toContain("TEST_TRADING_UNSUPPORTED");
  });

  it("executes CLOSE_LONG via the REST client", async () => {
    const client = makeClient();
    const closeLong: unknown[] = [];
    const orig = client.closeLong.bind(client);
    client.closeLong = (async (s: string, q: number) => {
      closeLong.push([s, q]);
      return orig(s, q);
    }) as MockClient["closeLong"];
    mockRoute({
      client,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: false,
    });
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload, action: "CLOSE_LONG" },
      baseEnv(),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
    expect(closeLong).toEqual([["BTCUSDT", 0.01]]);
  });

  it("executes CLOSE_SHORT via the REST client", async () => {
    const client = makeClient();
    const closeShort: unknown[] = [];
    const orig = client.closeShort.bind(client);
    client.closeShort = (async (s: string, q: number) => {
      closeShort.push([s, q]);
      return orig(s, q);
    }) as MockClient["closeShort"];
    mockRoute({
      client,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: false,
    });
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload, action: "CLOSE_SHORT" },
      baseEnv(),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
    expect(closeShort).toEqual([["BTCUSDT", 0.01]]);
  });

  it("executes SHORT via the REST client", async () => {
    const client = makeClient();
    mockRoute({
      client,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: false,
    });
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload, action: "SHORT" },
      baseEnv(),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ orderId: "short-BTCUSDT-0.01" });
  });

  it("continues when setLeverage fails", async () => {
    const client = makeClient();
    client.setLeverage = async () => {
      throw new Error("leverage not supported here");
    };
    mockRoute({
      client,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: false,
    });
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload, leverage: 10 },
      baseEnv(),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
  });

  it("returns 500 when no REST client is available", async () => {
    mockRoute({
      client: undefined,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: false,
    });
    const { ctx, seen } = makeCtx();
    void seen;
    const r = await executeTrade(
      { ...basePayload },
      baseEnv(),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toContain("No REST client available");
  });
});

describe("executeTrade - testnet credential-source logging", () => {
  let routeSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    routeSpy?.mockRestore();
  });

  it("warns when test trading uses live key bindings", async () => {
    const client = makeClient();
    routeSpy = spyOn(ExchangeRouter.prototype, "route").mockResolvedValue({
      client,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: true,
      credentialSource: "live",
    } as never);
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload, test: true },
      baseEnv(),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
  });

  it("logs testnet binding usage for dedicated testnet keys", async () => {
    const client = makeClient();
    routeSpy = spyOn(ExchangeRouter.prototype, "route").mockResolvedValue({
      client,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: true,
      credentialSource: "testnet",
    } as never);
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload, test: true },
      baseEnv(),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ orderId: "long-BTCUSDT-0.01" });
  });
});

describe("executeTrade - websocket DO path", () => {
  let routeSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    routeSpy?.mockRestore();
  });

  function doEnv(stubResult: unknown) {
    const stub = {
      executeTrade: async () => stubResult,
    };
    return baseEnv({
      EXCHANGE_CONNECTION_MANAGER: {
        idFromName: (name: string) => ({ name }),
        get: (_id: unknown) => stub,
      },
    });
  }

  function mockWsRoute() {
    routeSpy = spyOn(ExchangeRouter.prototype, "route").mockResolvedValue({
      client: undefined,
      exchange: "binance",
      useWebsocketDO: true,
      testnet: false,
    } as never);
  }

  it("returns the DO result on success", async () => {
    mockWsRoute();
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload },
      doEnv({ success: true, result: { orderId: "do-123" } }),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ orderId: "do-123" });
  });

  it("returns 500 when the DO reports failure", async () => {
    mockWsRoute();
    const { ctx } = makeCtx();
    const r = await executeTrade(
      { ...basePayload },
      doEnv({ success: false, error: "DO exploded" }),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toContain("DO exploded");
  });
});

describe("executeTrade - catch-path branches", () => {
  let routeSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    routeSpy?.mockRestore();
  });

  it("still returns 500 when dbLogger.logResponse throws in the catch path", async () => {
    // Route resolves with no REST client so the throw happens OUTSIDE the
    // inner route try/catch (which maps failures to 400) and lands in the
    // outer catch, where the failing logResponse covers its own try/catch.
    routeSpy = spyOn(ExchangeRouter.prototype, "route").mockResolvedValue({
      client: undefined,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: false,
    } as never);
    const { ctx } = makeCtx();
    const dbLogger = makeDbLogger();
    dbLogger.logResponse = async () => {
      throw new Error("D1 log down");
    };
    const r = await executeTrade(
      { ...basePayload },
      baseEnv(),
      dbLogger as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toContain("No REST client");
  });

  it("skips db logging in the catch path when dbLogId is null", async () => {
    routeSpy = spyOn(ExchangeRouter.prototype, "route").mockResolvedValue({
      client: undefined,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: false,
    } as never);
    const { ctx } = makeCtx();
    const dbLogger = makeDbLogger();
    const logSpy = spyOn(dbLogger, "logResponse");
    const r = await executeTrade(
      { ...basePayload },
      baseEnv(),
      dbLogger as never,
      Date.now(),
      null,
      ctx
    );
    expect(r.success).toBe(false);
    expect(r.status).toBe(500);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("sends a telegram notification on success when configured", async () => {
    const client = makeClient();
    routeSpy = spyOn(ExchangeRouter.prototype, "route").mockResolvedValue({
      client,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: false,
    } as never);
    const telegramFetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 });
    const { ctx, seen } = makeCtx();
    const env = baseEnv({
      TELEGRAM_SERVICE: { fetch: telegramFetch },
      TELEGRAM_INTERNAL_KEY_BINDING: "tg-key",
    });
    const r = await executeTrade(
      { ...basePayload },
      env,
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
    // success D1? no D1_SERVICE here; telegram + analytics go via waitUntil
    expect(seen.length).toBeGreaterThan(0);
    await Promise.all(seen);
  });

  it("writes D1 records on the success path when D1_SERVICE is configured", async () => {
    const client = makeClient();
    routeSpy = spyOn(ExchangeRouter.prototype, "route").mockResolvedValue({
      client,
      exchange: "binance",
      useWebsocketDO: false,
      testnet: false,
    } as never);
    const d1 = makeD1Service();
    const { ctx, seen } = makeCtx();
    const r = await executeTrade(
      { ...basePayload },
      baseEnv({ D1_SERVICE: d1.binding }),
      makeDbLogger() as never,
      Date.now(),
      "log-1",
      ctx
    );
    expect(r.success).toBe(true);
    for (const p of seen) {
      await p;
    }
    expect(d1.calls).toHaveLength(2);
  });
});
