/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/test/exchange-connection-manager.test.ts
//
// Unit tests for the `ExchangeConnectionManager` Durable Object. The DO
// maintains a long-lived WebSocket to the exchange and exposes an
// `executeTrade` RPC for placing orders from inside the "always online"
// connection.
//
// Mocking strategy:
//   * `cloudflare:workers` is mocked locally so the import of
//     `exchange-connection-manager` resolves under `bun test`.
//   * `global.fetch` is replaced with `mockFetch`; per-test setup uses
//     `mockResolvedValueOnce` to drive the four `connectToExchange`
//     branches (success, reentrancy, missing WS, fetch throws).
//   * A small `FakeWebSocket` records `accept()` calls and the registered
//     message/close/error listeners. Tests call `fire(...)` to invoke
//     them and observe the resulting state changes.

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";
import type { WebhookPayload } from "@hoox-sh/hoox-shared/types";

// --- Mock the `cloudflare:workers` built-in before importing the source ---
//
// The `cloudflare:workers` module is a workerd-only built-in; replace it
// with a minimal stub. The DO's `super(ctx, env)` call needs an instance
// surface that exposes `ctx` (so `this.ctx.waitUntil(...)` resolves) and
// `state`.
mock.module("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {
    ctx: any;
    state: any;
    constructor(ctx: any, state: any) {
      this.ctx = ctx;
      this.state = state;
    }
  },
}));

const { ExchangeConnectionManager } =
  await import("../src/exchange-connection-manager");
const { BinanceClient } = await import("../src/binance-client");

// --- fetch mock (replaces global fetch for the whole suite) ---
//
// CRITICAL: we use `spyOn(global, "fetch")` (via `beforeEach`) instead of
// a module-level `global.fetch = mockFetch` assignment. The previous
// implementation polluted the global `fetch` across test files, causing
// yoga-layout's WASM loader (in TUI tests) to fail with
// `TypeError: undefined is not an object (evaluating 'fetch(...)')`.
//
// `spyOn(global, "fetch")` is restored by `mock.restore()` in `afterEach`,
// which bun:test handles per-test and per-file. This avoids any cross-file
// pollution.
//
// We still keep `mockFetch` as a stable reference so individual tests can
// configure it with `mockResolvedValueOnce(...)`. We create it once at
// module load (no global side effect) and re-spy in each `beforeEach`.
const mockFetch = mock(() => Promise.resolve(new Response()));

// --- FakeWebSocket ---
//
// Mirrors the surface of the `WebSocket` returned by `Response.webSocket`
// that the DO actually touches: `accept()` and `addEventListener(type, cb)`.
class FakeWebSocket {
  acceptCount = 0;
  private listeners = new Map<string, (event: unknown) => void>();

  accept(): void {
    this.acceptCount += 1;
  }

  addEventListener(type: string, cb: (event: unknown) => void): void {
    this.listeners.set(type, cb);
  }

  /** Invoke a registered listener; used by tests to drive lifecycle events. */
  fire(type: string, event: unknown = {}): void {
    const cb = this.listeners.get(type);
    if (cb) cb(event);
  }

  listenerCount(type: string): number {
    return this.listeners.has(type) ? 1 : 0;
  }
}

/** Build a `Response` carrying a `webSocket` field, matching the
 *  `Response.webSocket` shape that the real Cloudflare runtime produces. */
function makeWsResponse(ws: FakeWebSocket | null): Response {
  const resp = new Response(null, { status: 101 });
  if (ws) (resp as any).webSocket = ws;
  return resp;
}

// --- mockCtx factory ---
//
// Storage is a `Map`; `setAlarm` records the scheduled timestamps so
// tests can assert on the reconnect / keep-alive schedule. `waitUntil`
// captures the most-recent background promise so the test can `await` it
// after the constructor returns.
function createMockCtx() {
  const storage = new Map<string, unknown>();
  const alarms: number[] = [];
  let lastPromise: Promise<unknown> | null = null;

  const ctx = {
    storage: {
      get: async <T>(key: string): Promise<T | undefined> =>
        storage.get(key) as T | undefined,
      put: async <T>(key: string, value: T): Promise<void> => {
        storage.set(key, value);
      },
      delete: async (key: string): Promise<boolean> => storage.delete(key),
      list: async <T>(): Promise<Map<string, T>> => {
        const out = new Map<string, T>();
        for (const [k, v] of storage) out.set(k, v as T);
        return out;
      },
      getAlarm: async (): Promise<number | null> =>
        alarms.length > 0 ? (alarms[alarms.length - 1] ?? null) : null,
      setAlarm: async (scheduledTime: number): Promise<void> => {
        alarms.push(scheduledTime);
      },
    },
    id: { name: "exchange:binance", toString: () => "exchange:binance-id" },
    waitUntil: (promise: Promise<unknown>) => {
      lastPromise = promise;
    },
    getAlarms: () => alarms,
    getLastWaitUntilPromise: () => lastPromise,
  };
  return ctx;
}

describe("ExchangeConnectionManager", () => {
  let mockCtx: ReturnType<typeof createMockCtx>;
  let env: {
    BINANCE_KEY_BINDING?: string;
    BINANCE_SECRET_BINDING?: string;
  };

  beforeEach(() => {
    // Use spyOn to replace `global.fetch` with our mock. spyOn is restored
    // by `mock.restore()` in afterEach, which is per-test isolated.
    spyOn(global, "fetch").mockImplementation(
      mockFetch as unknown as typeof fetch
    );
    mockCtx = createMockCtx();
    env = {
      BINANCE_KEY_BINDING: "test-key",
      BINANCE_SECRET_BINDING: "test-secret",
    };
  });

  afterEach(() => {
    // Restore the real `global.fetch` (and any other spies).
    mock.restore();
  });

  // ─── A. connectToExchange() ─────────────────────────────────────────────

  test("should accept WS, register all 3 listeners, reset isConnecting, and schedule 60s alarm on first connect", async () => {
    // Arrange
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));
    const beforeConnect = Date.now();

    // Act
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();

    // Assert
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(fakeWs.acceptCount).toBe(1);
    expect(fakeWs.listenerCount("message")).toBe(1);
    expect(fakeWs.listenerCount("close")).toBe(1);
    expect(fakeWs.listenerCount("error")).toBe(1);
    expect((doInstance as any).isConnecting).toBe(false);

    // Initial 60s alarm should be scheduled close to now+60s.
    const alarms = mockCtx.getAlarms();
    expect(alarms.length).toBeGreaterThan(0);
    const lastAlarm = alarms[alarms.length - 1];
    if (lastAlarm === undefined) throw new Error("expected alarm");
    const expected = beforeConnect + 60_000;
    expect(Math.abs(lastAlarm - expected)).toBeLessThan(2_000);
  });

  test("should return early from connectToExchange when ws is already set", async () => {
    // Arrange — drive a successful first connection, then verify the guard.
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();
    expect((doInstance as any).ws).not.toBeNull();
    mockFetch.mockClear();

    // Manually set ws (the spec's "already set" path) and call again.
    (doInstance as any).ws = new FakeWebSocket();

    // Act
    await doInstance.connectToExchange();

    // Assert — no new fetch issued thanks to the reentrancy guard.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("should return early from connectToExchange when isConnecting is true", async () => {
    // Arrange — a deferred fetch keeps the first call in flight so
    // `isConnecting` stays true while we issue the second call.
    let resolveFetch!: (resp: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    mockFetch.mockReturnValueOnce(pendingFetch as any);

    // Act — construct DO; its background connectToExchange is now in flight
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    // Synchronously, isConnecting is already true.
    expect((doInstance as any).isConnecting).toBe(true);

    // Second call while the first is still pending — must short-circuit.
    await doInstance.connectToExchange();

    // Assert — only the initial fetch was issued.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Cleanup — resolve the deferred fetch and let the first call settle.
    const fakeWs = new FakeWebSocket();
    resolveFetch(makeWsResponse(fakeWs));
    await mockCtx.getLastWaitUntilPromise();
  });

  test("should reset isConnecting and schedule 10s retry alarm when response.webSocket is missing", async () => {
    // Arrange — a successful HTTP upgrade with no `webSocket` field
    const respNoWs = new Response(null, { status: 101 });
    // (respNoWs.webSocket is undefined by construction)
    mockFetch.mockResolvedValueOnce(respNoWs);
    const beforeConnect = Date.now();

    // Act
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();

    // Assert
    // `this.ws` ends up as `undefined` here (the source assigns
    // `this.ws = resp.webSocket` before checking it), so accept any
    // falsy value as "no live socket".
    expect((doInstance as any).ws).toBeFalsy();
    expect((doInstance as any).isConnecting).toBe(false);
    const alarms = mockCtx.getAlarms();
    const lastAlarm = alarms[alarms.length - 1];
    if (lastAlarm === undefined) throw new Error("expected alarm");
    const expected = beforeConnect + 10_000;
    expect(Math.abs(lastAlarm - expected)).toBeLessThan(2_000);
  });

  test("should reset isConnecting and schedule 10s retry alarm when fetch throws", async () => {
    // Arrange
    mockFetch.mockRejectedValueOnce(new Error("Network down"));
    const beforeConnect = Date.now();

    // Act
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();

    // Assert
    expect((doInstance as any).ws).toBeNull();
    expect((doInstance as any).isConnecting).toBe(false);
    const alarms = mockCtx.getAlarms();
    const lastAlarm = alarms[alarms.length - 1];
    if (lastAlarm === undefined) throw new Error("expected alarm");
    const expected = beforeConnect + 10_000;
    expect(Math.abs(lastAlarm - expected)).toBeLessThan(2_000);
  });

  // ─── B. WebSocket lifecycle handlers ────────────────────────────────────

  test("should push alarm forward 60s on a 'message' event", async () => {
    // Arrange — successful first connect
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();
    const alarmsBefore = mockCtx.getAlarms().length;
    const beforeFire = Date.now();

    // Act
    fakeWs.fire("message", { data: "ticker-update" });

    // Assert
    const alarms = mockCtx.getAlarms();
    expect(alarms.length).toBe(alarmsBefore + 1);
    const lastAlarm = alarms[alarms.length - 1];
    expect(lastAlarm).toBeGreaterThanOrEqual(beforeFire + 60_000);
    expect(lastAlarm).toBeLessThan(beforeFire + 65_000);
    // Sanity — DO state should not change as a side effect of messages.
    expect((doInstance as any).ws).toBe(fakeWs);
  });

  test("should null ws, clear isConnecting, and schedule 5s reconnect alarm on 'close'", async () => {
    // Arrange
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();
    const alarmsBefore = mockCtx.getAlarms().length;
    const beforeFire = Date.now();

    // Act
    fakeWs.fire("close", { code: 1006 });

    // Assert
    expect((doInstance as any).ws).toBeNull();
    expect((doInstance as any).isConnecting).toBe(false);
    const alarms = mockCtx.getAlarms();
    expect(alarms.length).toBe(alarmsBefore + 1);
    const lastAlarm = alarms[alarms.length - 1];
    expect(lastAlarm).toBeGreaterThanOrEqual(beforeFire + 5_000);
    expect(lastAlarm).toBeLessThan(beforeFire + 10_000);
  });

  test("should null ws and clear isConnecting on 'error' (no alarm scheduled)", async () => {
    // Arrange
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();
    const alarmsBefore = mockCtx.getAlarms().length;

    // Act
    fakeWs.fire("error", new Error("ws-error"));

    // Assert
    expect((doInstance as any).ws).toBeNull();
    expect((doInstance as any).isConnecting).toBe(false);
    // The error path does NOT schedule an alarm (only close does).
    expect(mockCtx.getAlarms().length).toBe(alarmsBefore);
  });

  // ─── C. alarm() ────────────────────────────────────────────────────────

  test("should call connectToExchange from alarm() when ws is null", async () => {
    // Arrange — first connection attempt fails, leaving ws null
    mockFetch.mockRejectedValueOnce(new Error("first attempt failed"));
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();
    expect((doInstance as any).ws).toBeNull();
    mockFetch.mockClear();

    // Prepare a successful response for the reconnect attempt
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));

    // Act
    await doInstance.alarm();

    // Assert
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The reconnect succeeded — ws is now set and isConnecting cleared.
    expect((doInstance as any).ws).toBe(fakeWs);
    expect((doInstance as any).isConnecting).toBe(false);
  });

  test("should push 60s alarm forward from alarm() when ws is connected (no new fetch)", async () => {
    // Arrange
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();
    expect((doInstance as any).ws).toBe(fakeWs);
    mockFetch.mockClear();
    const alarmsBefore = mockCtx.getAlarms().length;
    const beforeAlarm = Date.now();

    // Act
    await doInstance.alarm();

    // Assert
    expect(mockFetch).not.toHaveBeenCalled();
    const alarms = mockCtx.getAlarms();
    expect(alarms.length).toBe(alarmsBefore + 1);
    const lastAlarm = alarms[alarms.length - 1];
    expect(lastAlarm).toBeGreaterThanOrEqual(beforeAlarm + 60_000);
    expect(lastAlarm).toBeLessThan(beforeAlarm + 65_000);
  });

  // ─── D. executeTrade() RPC ─────────────────────────────────────────────

  test("should return 400 'Missing credentials' when BINANCE_KEY_BINDING is missing", async () => {
    // Arrange — DO with no fetch setup needed; executeTrade is pure RPC
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    const envNoKey: typeof env = { ...env, BINANCE_KEY_BINDING: undefined };
    const payload: WebhookPayload = {
      exchange: "binance",
      action: "LONG",
      symbol: "BTCUSDT",
      quantity: 0.01,
    };

    // Act
    const result = await doInstance.executeTrade(payload, envNoKey as any);

    // Assert
    expect(result).toEqual({
      success: false,
      error: "Missing binance credentials",
      status: 400,
    });
  });

  test("should return 400 for invalid action (e.g. 'FOO')", async () => {
    // Arrange
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    const payload = {
      exchange: "binance",
      action: "FOO",
      symbol: "BTCUSDT",
      quantity: 0.01,
    } as unknown as WebhookPayload;

    // Act
    const result = await doInstance.executeTrade(payload, env as any);

    // Assert
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/Invalid action/);
  });

  test("should call BinanceClient.openLong with (symbol, quantity, price, orderType) for action=LONG", async () => {
    // Arrange
    const openLongSpy = spyOn(
      BinanceClient.prototype,
      "openLong"
    ).mockResolvedValue({
      orderId: "long-1",
      symbol: "BTCUSDT",
      status: "FILLED",
    });
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    const payload: WebhookPayload = {
      exchange: "binance",
      action: "LONG",
      symbol: "BTCUSDT",
      quantity: 0.01,
      price: 50_000,
      orderType: "LIMIT",
    };

    // Act
    const result = await doInstance.executeTrade(payload, env as any);

    // Assert
    expect(openLongSpy).toHaveBeenCalledTimes(1);
    expect(openLongSpy).toHaveBeenCalledWith("BTCUSDT", 0.01, 50_000, "LIMIT");
    expect(result).toEqual({
      success: true,
      result: { orderId: "long-1", symbol: "BTCUSDT", status: "FILLED" },
      status: 200,
    });
  });

  test("executeTrade uses REST even when WS is connected and ready", async () => {
    // Arrange — successful WS connect, then spy REST openLong
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));
    const openLongSpy = spyOn(
      BinanceClient.prototype,
      "openLong"
    ).mockResolvedValue({
      orderId: "rest-1",
      symbol: "BTCUSDT",
      status: "FILLED",
    });
    const requestSpy = spyOn(
      ExchangeConnectionManager.prototype as any,
      "request"
    );

    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();
    expect((doInstance as any).ready).toBe(true);
    expect((doInstance as any).ws).toBe(fakeWs);

    const payload: WebhookPayload = {
      exchange: "binance",
      action: "LONG",
      symbol: "BTCUSDT",
      quantity: 0.02,
      price: 42_000,
      orderType: "MARKET",
    };

    // Act
    const result = await doInstance.executeTrade(payload, env as any);

    // Assert — REST path used; WS request() never called for order place
    expect(requestSpy).not.toHaveBeenCalled();
    expect(openLongSpy).toHaveBeenCalledTimes(1);
    expect(openLongSpy).toHaveBeenCalledWith(
      "BTCUSDT",
      0.02,
      42_000,
      "MARKET"
    );
    expect(result).toEqual({
      success: true,
      result: { orderId: "rest-1", symbol: "BTCUSDT", status: "FILLED" },
      status: 200,
    });

    requestSpy.mockRestore();
  });
});
