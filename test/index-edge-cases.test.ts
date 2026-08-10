/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Edge-case coverage for trade-worker src/index.ts:
 * body size guards, parseJsonBody, missing payload, queue consumer,
 * handleError paths, and factories.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  jest as vi,
} from "bun:test";

import worker, { factories } from "../src/index";
import { factories as routerFactories } from "../src/exchange-router";
import * as executionModule from "../src/execution.js";

const createMockClient = () => ({
  setLeverage: vi.fn().mockResolvedValue({}),
  executeTrade: vi.fn(),
  getAccountInfo: vi.fn(),
  getPositions: vi.fn(),
  openLong: vi.fn().mockResolvedValue({ orderId: "ord-1" }),
  openShort: vi.fn(),
  closeLong: vi.fn(),
  closeShort: vi.fn(),
});

const mockMexcClient = createMockClient();
const mockLogRequest = vi.fn();
const mockLogResponse = vi.fn();
const mockDbLogger = {
  logRequest: mockLogRequest,
  logResponse: mockLogResponse,
  logTrade: vi.fn(),
};

vi.spyOn(routerFactories, "createMexcClient").mockImplementation(
  () => mockMexcClient as any
);
vi.spyOn(routerFactories, "createBinanceClient").mockImplementation(
  () => createMockClient() as any
);
vi.spyOn(routerFactories, "createBybitClient").mockImplementation(
  () => createMockClient() as any
);
vi.spyOn(factories, "createDbLogger").mockImplementation(
  () => mockDbLogger as any
);

const mockEnv = {
  DB: {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        run: vi.fn(),
        all: vi.fn(),
      })),
    })),
  },
  CONFIG_KV: {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
  AI: { run: vi.fn() },
  REPORTS_BUCKET: {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
  INTERNAL_KEY_BINDING: "test-internal-key",
  TELEGRAM_SERVICE: {
    fetch: vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      ),
  },
  TELEGRAM_INTERNAL_KEY_BINDING: "test-telegram-key",
  MEXC_KEY_BINDING: "mexc-key",
  MEXC_SECRET_BINDING: "mexc-secret",
  BINANCE_KEY_BINDING: "binance-key",
  BINANCE_SECRET_BINDING: "binance-secret",
  BYBIT_KEY_BINDING: "bybit-key",
  BYBIT_SECRET_BINDING: "bybit-secret",
  D1_SERVICE: {
    fetch: vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      ),
  },
} as any;

const validPayload = {
  exchange: "mexc",
  action: "LONG",
  symbol: "BTC_USDT",
  quantity: 0.01,
  leverage: 10,
};

function authHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Internal-Auth-Key": "test-internal-key",
    ...extra,
  };
}

function mockCtx() {
  return { waitUntil: vi.fn() } as any;
}

describe("Trade Worker - parseJsonBody / body size guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogRequest.mockResolvedValue("log-1");
    mockLogResponse.mockResolvedValue(undefined);
    mockMexcClient.openLong.mockResolvedValue({ orderId: "ord-1" });
    mockMexcClient.setLeverage.mockResolvedValue({});
  });

  it("rejects invalid Content-Length", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders({ "Content-Length": "not-a-number" }),
      body: JSON.stringify(validPayload),
    });
    const response = await worker.fetch(request, mockEnv, mockCtx());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/Content-Length/i);
  });

  it("rejects negative Content-Length", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders({ "Content-Length": "-1" }),
      body: JSON.stringify(validPayload),
    });
    const response = await worker.fetch(request, mockEnv, mockCtx());
    expect(response.status).toBe(400);
  });

  it("rejects oversized Content-Length (>256KB)", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders({
        "Content-Length": String(300 * 1024),
      }),
      body: JSON.stringify(validPayload),
    });
    const response = await worker.fetch(request, mockEnv, mockCtx());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/too large/i);
  });

  it("rejects empty request body", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders(),
      body: "",
    });
    const response = await worker.fetch(request, mockEnv, mockCtx());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/empty|invalid|json/i);
  });

  it("rejects malformed JSON body via stream parse", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders(),
      body: "{ not-json",
    });
    const response = await worker.fetch(request, mockEnv, mockCtx());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/json|invalid/i);
  });

  it("rejects oversized streaming body without relying on Content-Length alone", async () => {
    // 257 KiB of 'a' — over the 256 KiB hard cap when streamed
    const big = "x".repeat(257 * 1024);
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders(),
      body: big,
    });
    const response = await worker.fetch(request, mockEnv, mockCtx());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/too large|json|invalid/i);
  });
});

describe("Trade Worker - /process missing payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogRequest.mockResolvedValue("log-2");
    mockLogResponse.mockResolvedValue(undefined);
  });

  it("returns 400 when process body has no nested payload", async () => {
    const request = new Request("http://localhost/process", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        requestId: "req-no-payload",
        internalAuthKey: "test-internal-key",
      }),
    });
    const response = await worker.fetch(request, mockEnv, mockCtx());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/payload/i);
    expect(mockLogResponse).toHaveBeenCalled();
  });
});

describe("Trade Worker - handleError paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogRequest.mockResolvedValue("log-err");
    mockLogResponse.mockResolvedValue(undefined);
  });

  it("returns 500 when executeTrade throws after request was logged", async () => {
    const spy = vi
      .spyOn(executionModule, "executeTrade")
      .mockRejectedValueOnce(new Error("boom-after-log"));
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(validPayload),
    });
    const response = await worker.fetch(request, mockEnv, mockCtx());
    expect(response.status).toBe(500);
    expect(mockLogResponse).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns 500 when executeTrade throws on /process", async () => {
    const spy = vi
      .spyOn(executionModule, "executeTrade")
      .mockRejectedValueOnce(new Error("process-boom"));
    const request = new Request("http://localhost/process", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        requestId: "r1",
        payload: validPayload,
      }),
    });
    const response = await worker.fetch(request, mockEnv, mockCtx());
    expect(response.status).toBe(500);
    spy.mockRestore();
  });

  it("handles error when logRequest never obtained an id", async () => {
    mockLogRequest.mockRejectedValueOnce(new Error("log failed"));
    // Second call is fallback logRequest inside handleError
    mockLogRequest.mockResolvedValueOnce("fallback-id");
    const spy = vi
      .spyOn(executionModule, "executeTrade")
      .mockRejectedValueOnce(new Error("trade-fail"));
    // Force path: logRequest must succeed first for trade path; to hit
    // dbLogId===null branch, fail logRequest before executeTrade.
    mockLogRequest.mockReset();
    mockLogRequest.mockRejectedValue(new Error("cannot log"));

    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(validPayload),
    });
    const response = await worker.fetch(request, mockEnv, mockCtx());
    // Auth + parse succeed; logRequest throws → handleError with null dbLogId
    expect(response.status).toBe(500);
    spy.mockRestore();
  });
});

describe("Trade Worker - config auth error logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogRequest.mockResolvedValue("cfg-log");
    mockLogResponse.mockResolvedValue(undefined);
  });

  it("logs config error when no execute auth key is bound (webhook)", async () => {
    const envNoKey = {
      ...mockEnv,
      INTERNAL_KEY_BINDING: undefined,
      TRADE_EXECUTE_KEY_BINDING: undefined,
    };
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(validPayload),
    });
    const response = await worker.fetch(request, envNoKey, mockCtx());
    expect(response.status).toBe(500);
  });

  it("logs config error when no execute auth key is bound (process)", async () => {
    const envNoKey = {
      ...mockEnv,
      INTERNAL_KEY_BINDING: undefined,
      TRADE_EXECUTE_KEY_BINDING: undefined,
    };
    const request = new Request("http://localhost/process", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ payload: validPayload }),
    });
    const response = await worker.fetch(request, envNoKey, mockCtx());
    expect(response.status).toBe(500);
  });
});

describe("Trade Worker - factories", () => {
  it("createDbLogger real implementation constructs DbLogger", () => {
    const spy = factories.createDbLogger as unknown as {
      mockRestore?: () => void;
      getMockImplementation?: () => unknown;
    };
    // Restore spy so we exercise the production factory body
    if (typeof (factories.createDbLogger as any).mockRestore === "function") {
      (factories.createDbLogger as any).mockRestore();
    }
    try {
      const logger = factories.createDbLogger(mockEnv);
      expect(logger).toBeDefined();
      expect(typeof logger.logRequest).toBe("function");
    } finally {
      // Re-install mock for remaining tests
      vi.spyOn(factories, "createDbLogger").mockImplementation(
        () => mockDbLogger as any
      );
    }
    void spy;
  });
});

describe("Trade Worker - queue consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogRequest.mockResolvedValue("q-log");
    mockLogResponse.mockResolvedValue(undefined);
    mockMexcClient.openLong.mockResolvedValue({ orderId: "q-ord" });
    mockMexcClient.setLeverage.mockResolvedValue({});
  });

  function makeBatch(
    body: unknown,
    opts: { attempts?: number; id?: string } = {}
  ) {
    const retry = vi.fn();
    return {
      messages: [
        {
          id: opts.id ?? "msg-1",
          body,
          attempts: opts.attempts ?? 0,
          retry,
          ack: vi.fn(),
        },
      ],
      queue: "trade-queue",
    } as any;
  }

  const validQueueMsg = {
    requestId: "qid-1",
    exchange: "mexc",
    action: "LONG",
    symbol: "BTC_USDT",
    quantity: 0.01,
    leverage: 5,
    queuedAt: new Date().toISOString(),
  };

  it("processes a valid queue message successfully", async () => {
    const batch = makeBatch(validQueueMsg);
    await worker.queue(batch, mockEnv, mockCtx());
    expect(mockMexcClient.openLong).toHaveBeenCalled();
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
  });

  it("retries on invalid queue message schema", async () => {
    const batch = makeBatch({ not: "a trade" }, { attempts: 0 });
    await worker.queue(batch, mockEnv, mockCtx());
    expect(batch.messages[0].retry).toHaveBeenCalled();
  });

  it("retries when trade execution fails (attempts < max)", async () => {
    mockMexcClient.openLong.mockRejectedValueOnce(new Error("exchange down"));
    const batch = makeBatch(validQueueMsg, { attempts: 1 });
    await worker.queue(batch, mockEnv, mockCtx());
    expect(batch.messages[0].retry).toHaveBeenCalledWith(
      expect.objectContaining({ delaySeconds: expect.any(Number) })
    );
  });

  it("logs failed trade and notifies on DLQ (max retries exceeded)", async () => {
    mockMexcClient.openLong.mockRejectedValue(new Error("permanent fail"));
    mockEnv.D1_SERVICE.fetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );
    const batch = makeBatch(validQueueMsg, { attempts: 5 });
    await worker.queue(batch, mockEnv, mockCtx());
    // DLQ path should not call retry
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
    // D1 insert-system-log for failed trade
    expect(mockEnv.D1_SERVICE.fetch).toHaveBeenCalled();
    // Telegram failure notification
    expect(mockEnv.TELEGRAM_SERVICE.fetch).toHaveBeenCalled();
  });

  it("skips D1 failed-trade log when write auth key missing", async () => {
    mockMexcClient.openLong.mockRejectedValue(new Error("fail"));
    const envNoWrite = {
      ...mockEnv,
      INTERNAL_KEY_BINDING: undefined,
      D1_WRITE_KEY_BINDING: undefined,
      // Still need telegram key for notification; may also fail-closed
      TELEGRAM_INTERNAL_KEY_BINDING: "tg",
      D1_SERVICE: {
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ success: true }), { status: 200 })
        ),
      },
    };
    // Queue still needs trade credentials for execute attempt
    envNoWrite.MEXC_KEY_BINDING = "mexc-key";
    envNoWrite.MEXC_SECRET_BINDING = "mexc-secret";
    const batch = makeBatch(validQueueMsg, { attempts: 5 });
    await worker.queue(batch, envNoWrite, mockCtx());
    // Without D1 write key, insert-system-log should not be called
    expect(envNoWrite.D1_SERVICE.fetch).not.toHaveBeenCalled();
  });

  it("handles D1 log failure on DLQ without throwing", async () => {
    mockMexcClient.openLong.mockRejectedValue(new Error("fail"));
    mockEnv.D1_SERVICE.fetch.mockRejectedValueOnce(new Error("d1 down"));
    const batch = makeBatch(validQueueMsg, { attempts: 5 });
    await expect(
      worker.queue(batch, mockEnv, mockCtx())
    ).resolves.toBeUndefined();
  });
});

describe("Trade Worker - successful trade analytics + report save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogRequest.mockResolvedValue("ok-log");
    mockLogResponse.mockResolvedValue(undefined);
    mockMexcClient.openLong.mockResolvedValue({ orderId: "ok-1" });
    mockMexcClient.setLeverage.mockResolvedValue({});
  });

  it("queues waitUntil work on successful webhook trade", async () => {
    const ctx = mockCtx();
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(validPayload),
    });
    const response = await worker.fetch(request, mockEnv, ctx);
    expect(response.status).toBe(200);
    // analytics + report save
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it("queues waitUntil work on successful process trade", async () => {
    const ctx = mockCtx();
    const request = new Request("http://localhost/process", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        requestId: "analytics-req",
        payload: validPayload,
      }),
    });
    const response = await worker.fetch(request, mockEnv, ctx);
    expect(response.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it("does not save report when trade fails", async () => {
    mockMexcClient.openLong.mockRejectedValueOnce(new Error("no funds"));
    const ctx = mockCtx();
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(validPayload),
    });
    const response = await worker.fetch(request, mockEnv, ctx);
    expect(response.status).toBe(500);
    expect(mockEnv.REPORTS_BUCKET.put).not.toHaveBeenCalled();
  });

  it("swallows report-save failures via waitUntil catch", async () => {
    mockEnv.REPORTS_BUCKET.put.mockRejectedValueOnce(new Error("r2 down"));
    const ctx = mockCtx();
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(validPayload),
    });
    const response = await worker.fetch(request, mockEnv, ctx);
    expect(response.status).toBe(200);
    // Flush waitUntil promises (report save + analytics)
    const pending = (ctx.waitUntil as any).mock.calls.map(
      (c: unknown[]) => c[0]
    );
    await Promise.all(
      pending.map((p: Promise<unknown>) =>
        Promise.resolve(p).catch(() => undefined)
      )
    );
  });
});

describe("Trade Worker - queue executeTradeFromQueue throw path", () => {
  it("retries when executeTrade throws (not just returns failure)", async () => {
    const spy = vi
      .spyOn(executionModule, "executeTrade")
      .mockRejectedValueOnce(new Error("hard throw"));
    const retry = vi.fn();
    const batch = {
      messages: [
        {
          id: "throw-msg",
          body: {
            requestId: "qid-throw",
            exchange: "mexc",
            action: "LONG",
            symbol: "BTC_USDT",
            quantity: 0.01,
            queuedAt: new Date().toISOString(),
          },
          attempts: 0,
          retry,
          ack: vi.fn(),
        },
      ],
      queue: "trade-queue",
    } as any;
    await worker.queue(batch, mockEnv, mockCtx());
    expect(retry).toHaveBeenCalled();
    spy.mockRestore();
  });
});
