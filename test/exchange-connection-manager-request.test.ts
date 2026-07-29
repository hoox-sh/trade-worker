/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/test/exchange-connection-manager-request.test.ts
//
// Tests for the WS request/response correlation logic in
// ExchangeConnectionManager. The base DO behavior is covered in
// exchange-connection-manager.test.ts; this file focuses on `request()`.

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";

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

const mockFetch = mock(() => Promise.resolve(new Response()));

class FakeWebSocket {
  acceptCount = 0;
  sent: string[] = [];
  private listeners = new Map<string, (event: unknown) => void>();

  accept(): void {
    this.acceptCount = 1;
  }

  addEventListener(type: string, cb: (event: unknown) => void): void {
    this.listeners.set(type, cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  fire(type: string, event: unknown = {}): void {
    const cb = this.listeners.get(type);
    if (cb) cb(event);
  }
}

function makeWsResponse(ws: FakeWebSocket | null): Response {
  const resp = new Response(null, { status: 101 });
  if (ws) (resp as any).webSocket = ws;
  return resp;
}

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
        alarms.length > 0 ? alarms[alarms.length - 1] : null,
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

describe("ExchangeConnectionManager.request()", () => {
  let mockCtx: ReturnType<typeof createMockCtx>;
  let env: {
    BINANCE_KEY_BINDING?: string;
    BINANCE_SECRET_BINDING?: string;
  };

  beforeEach(() => {
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
    mock.restore();
  });

  test("request() resolves with result when matching response arrives", async () => {
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();

    const promise = (doInstance as any).request(
      "order.place",
      { symbol: "BTCUSDT" },
      5_000
    );

    // Let microtasks settle so the request registers in the pending map
    await new Promise((r) => setTimeout(r, 5));

    const pendingMap = (doInstance as any).pending as Map<string, unknown>;
    expect(pendingMap.size).toBe(1);
    const id = [...pendingMap.keys()][0];

    // Deliver a matching response
    fakeWs.fire("message", {
      data: JSON.stringify({ id, result: { orderId: "o1" } }),
    });

    await expect(promise).resolves.toEqual({ orderId: "o1" });
  });

  test("request() rejects on adapter error response", async () => {
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();

    const promise = (doInstance as any).request("order.place", {}, 5_000);
    await new Promise((r) => setTimeout(r, 5));
    const pendingMap = (doInstance as any).pending as Map<string, unknown>;
    const id = [...pendingMap.keys()][0];

    fakeWs.fire("message", {
      data: JSON.stringify({ id, error: { code: -1002, msg: "Unauthorized" } }),
    });

    await expect(promise).rejects.toThrow(/Unauthorized/);
  });

  test("request() rejects after timeout", async () => {
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();

    const promise = (doInstance as any).request("order.place", {}, 50);

    await expect(promise).rejects.toThrow(/timed out/);
  });

  test("request() rejects if ws is not connected", async () => {
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();
    (doInstance as any).ws = null;

    await expect(
      (doInstance as any).request("order.place", {}, 5_000)
    ).rejects.toThrow(/not connected/);
  });

  test("WS close event rejects all in-flight requests", async () => {
    const fakeWs = new FakeWebSocket();
    mockFetch.mockResolvedValueOnce(makeWsResponse(fakeWs));
    const doInstance = new ExchangeConnectionManager(
      mockCtx as any,
      env as any
    );
    await mockCtx.getLastWaitUntilPromise();

    const p1 = (doInstance as any).request("order.place", {}, 5_000);
    const p2 = (doInstance as any).request("order.place", {}, 5_000);

    // Wait for both requests to register in the pending map (HMAC sign is async)
    await new Promise((r) => setTimeout(r, 50));

    const pendingMap = (doInstance as any).pending as Map<string, unknown>;
    expect(pendingMap.size).toBe(2);

    // Capture the rejection messages via .catch before firing close, so
    // the close handler's rejection is observed by a registered handler
    // (avoids bun:test's unhandled-rejection check).
    const p1Error = p1.catch((e: unknown) => e);
    const p2Error = p2.catch((e: unknown) => e);

    // Fire the close event. The close handler schedules a queueMicrotask
    // to clear the pending map and reject in-flight requests.
    fakeWs.fire("close", { code: 1006 });

    // Give the queueMicrotask a few macrotask ticks to run.
    await new Promise((r) => setTimeout(r, 10));

    const e1 = await p1Error;
    const e2 = await p2Error;

    expect(e1).toBeInstanceOf(Error);
    expect((e1 as Error).message).toMatch(/closed/);
    expect(e2).toBeInstanceOf(Error);
    expect((e2 as Error).message).toMatch(/closed/);
  });
});
