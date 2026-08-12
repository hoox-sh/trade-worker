/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/test/exchange-router-websocket.test.ts
//
// Proves that exchange:*:use_websocket=true does not route order placement
// through the WS DO. REST client is always constructed for live orders.

import { describe, expect, it, spyOn, beforeEach, afterEach } from "bun:test";
import { ExchangeRouter, factories } from "../src/exchange-router";
import type { WebhookPayload } from "@hoox-sh/hoox-shared/types";

describe("ExchangeRouter WS order placement gate", () => {
  const baseEnv = {
    BINANCE_KEY_BINDING: "binance-key",
    BINANCE_SECRET_BINDING: "binance-secret",
    BYBIT_KEY_BINDING: "bybit-key",
    BYBIT_SECRET_BINDING: "bybit-secret",
    MEXC_KEY_BINDING: "mexc-key",
    MEXC_SECRET_BINDING: "mexc-secret",
  } as any;

  const mockClient = {
    openLong: () => Promise.resolve({}),
    openShort: () => Promise.resolve({}),
    closeLong: () => Promise.resolve({}),
    closeShort: () => Promise.resolve({}),
    getAccountInfo: () => Promise.resolve({}),
  };

  let createBinanceSpy: ReturnType<typeof spyOn>;
  let createBybitSpy: ReturnType<typeof spyOn>;
  let createMexcSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createBinanceSpy = spyOn(factories, "createBinanceClient").mockReturnValue(
      mockClient as any
    );
    createBybitSpy = spyOn(factories, "createBybitClient").mockReturnValue(
      mockClient as any
    );
    createMexcSpy = spyOn(factories, "createMexcClient").mockReturnValue(
      mockClient as any
    );
  });

  afterEach(() => {
    createBinanceSpy.mockRestore();
    createBybitSpy.mockRestore();
    createMexcSpy.mockRestore();
  });

  function kvEnv(useWebsocket: string | null) {
    return {
      ...baseEnv,
      CONFIG_KV: {
        get: async (key: string) => {
          if (key.endsWith(":use_websocket")) return useWebsocket;
          if (key.endsWith(":enabled")) return "true";
          return null;
        },
      },
    } as any;
  }

  const longPayload = (exchange: string): WebhookPayload => ({
    exchange,
    action: "LONG",
    symbol: "BTCUSDT",
    quantity: 0.01,
  });

  it("routes binance live to REST when use_websocket=true", async () => {
    const router = new ExchangeRouter();
    const result = await router.route(longPayload("binance"), kvEnv("true"));
    expect(result.useWebsocketDO).toBe(false);
    expect(result.client).toBeDefined();
    expect(createBinanceSpy).toHaveBeenCalledTimes(1);
  });

  it("routes bybit live to REST when use_websocket=true", async () => {
    const router = new ExchangeRouter();
    const result = await router.route(longPayload("bybit"), kvEnv("true"));
    expect(result.useWebsocketDO).toBe(false);
    expect(result.client).toBeDefined();
    expect(createBybitSpy).toHaveBeenCalledTimes(1);
  });

  it("routes mexc live to REST when use_websocket=true", async () => {
    const router = new ExchangeRouter();
    const result = await router.route(
      { ...longPayload("mexc"), symbol: "BTC_USDT" },
      kvEnv("true")
    );
    expect(result.useWebsocketDO).toBe(false);
    expect(result.client).toBeDefined();
    expect(createMexcSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps REST when use_websocket is unset", async () => {
    const router = new ExchangeRouter();
    const result = await router.route(longPayload("binance"), kvEnv(null));
    expect(result.useWebsocketDO).toBe(false);
    expect(result.client).toBeDefined();
  });
});
