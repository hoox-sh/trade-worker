/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the trade-worker notifications module.
 * Covers sendTradeNotificationToTelegram and sendTradeNotification.
 */
import { describe, test, expect, mock } from "bun:test";

describe("sendTradeNotificationToTelegram", () => {
  // Explicit any-args mock so `mockResolvedValue` and `mockRejectedValue` are
  // both assignable across tests (the default `mock(...)` infers from the
  // first call and rejects subsequent re-mocks with different signatures).
  const mockFetch = mock<(...args: any[]) => any>(
    () => new Response(null, { status: 200 })
  );
  const mockEnv = {
    TELEGRAM_SERVICE: { fetch: mockFetch },
    TELEGRAM_INTERNAL_KEY_BINDING: "test-telegram-key",
  };
  const successResult = {
    success: true,
    result: { orderId: "abc123" },
  };
  const failureResult = {
    success: false,
    error: "Insufficient balance",
  };

  test("returns early when TELEGRAM_SERVICE is not configured", async () => {
    const { sendTradeNotificationToTelegram } =
      await import("../src/notifications");
    await sendTradeNotificationToTelegram(
      {},
      successResult,
      "mexc",
      "LONG",
      0.01,
      "BTC_USDT",
      "test-id"
    );
    // No fetch call should be made
  });

  test("sends successful trade notification to Telegram", async () => {
    const { sendTradeNotificationToTelegram } =
      await import("../src/notifications");
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

    await sendTradeNotificationToTelegram(
      mockEnv as any,
      successResult,
      "mexc",
      "LONG",
      0.01,
      "BTC_USDT",
      "test-id"
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as any;
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as any)["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.message).toContain("Trade executed successfully");
    expect(body.message).toContain("mexc");
    expect(body.message).toContain("LONG");
    expect(body.message).toContain("0.01");
  });

  test("sends failure trade notification to Telegram", async () => {
    const { sendTradeNotificationToTelegram } =
      await import("../src/notifications");
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

    await sendTradeNotificationToTelegram(
      mockEnv as any,
      failureResult,
      "binance",
      "SHORT",
      0.1,
      "ETH_USDT",
      "test-id-2"
    );

    expect(mockFetch).toHaveBeenCalled();
    const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as any;
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.message).toContain("Trade execution failed");
    expect(body.message).toContain("Insufficient balance");
  });

  test("includes internal auth key when configured", async () => {
    const { sendTradeNotificationToTelegram } =
      await import("../src/notifications");
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

    await sendTradeNotificationToTelegram(
      { ...mockEnv, TELEGRAM_INTERNAL_KEY_BINDING: "secret-key-123" } as any,
      successResult,
      "mexc",
      "LONG",
      0.01,
      "BTC_USDT",
      "test-id"
    );

    const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as any;
    const init = call[1] as RequestInit;
    expect(init.headers).toBeDefined();
    expect(
      (init.headers as Record<string, string>)["X-Internal-Auth-Key"]
    ).toBe("secret-key-123");
  });

  test("handles TELEGRAM_SERVICE non-ok response gracefully", async () => {
    const { sendTradeNotificationToTelegram } =
      await import("../src/notifications");
    mockFetch.mockResolvedValue(new Response("Service error", { status: 503 }));

    // Should not throw
    await sendTradeNotificationToTelegram(
      mockEnv as any,
      successResult,
      "mexc",
      "LONG",
      0.01,
      "BTC_USDT",
      "test-id"
    );
  });

  test("handles TELEGRAM_SERVICE fetch exception gracefully", async () => {
    const { sendTradeNotificationToTelegram } =
      await import("../src/notifications");
    mockFetch.mockRejectedValue(new Error("Network error"));

    // Should not throw
    await sendTradeNotificationToTelegram(
      mockEnv as any,
      successResult,
      "mexc",
      "LONG",
      0.01,
      "BTC_USDT",
      "test-id"
    );
  });
});

describe("sendTradeNotification", () => {
  test("forwards queue message to sendTradeNotificationToTelegram", async () => {
    const mockEnv = {
      TELEGRAM_SERVICE: {
        fetch: mock(() => new Response(null, { status: 200 })),
      },
      TELEGRAM_INTERNAL_KEY_BINDING: "key",
    };
    const { sendTradeNotification } = await import("../src/notifications");

    await sendTradeNotification(
      {
        requestId: "req-1",
        exchange: "bybit",
        action: "CLOSE_SHORT",
        symbol: "SOL_USDT",
        quantity: 5,
        queuedAt: new Date().toISOString(),
      },
      mockEnv as any,
      { success: true, result: { orderId: "abc" } }
    );

    expect(mockEnv.TELEGRAM_SERVICE.fetch).toHaveBeenCalled();
  });

  test("labels exchange with [TEST] when trade.test is true", async () => {
    const mockFetch = mock(() => new Response(null, { status: 200 }));
    const mockEnv = {
      TELEGRAM_SERVICE: { fetch: mockFetch },
      TELEGRAM_INTERNAL_KEY_BINDING: "key",
    };
    const { sendTradeNotification } = await import("../src/notifications");

    await sendTradeNotification(
      {
        requestId: "req-2",
        exchange: "binance",
        action: "LONG",
        symbol: "BTCUSDT",
        quantity: 0.01,
        test: true,
        queuedAt: new Date().toISOString(),
      },
      mockEnv as any,
      { success: false, error: "dlq" }
    );

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string
    );
    expect(body.message).toContain("binance [TEST]");
  });
});
