/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for per-exchange test trading (`test: true` on webhook/queue payloads).
 */

import { describe, expect, it, spyOn, beforeEach, afterEach } from "bun:test";
import {
  ExchangeRouter,
  factories,
  EXCHANGE_TEST_SUPPORT,
  BinanceProvider,
  BybitProvider,
  MexcProvider,
} from "../src/exchange-router";
import type { WebhookPayload } from "@jango-blockchained/hoox-shared/types";

describe("EXCHANGE_TEST_SUPPORT", () => {
  it("marks binance and bybit as supporting test trading", () => {
    expect(EXCHANGE_TEST_SUPPORT.binance).toBe(true);
    expect(EXCHANGE_TEST_SUPPORT.bybit).toBe(true);
  });

  it("marks mexc as not supporting test trading", () => {
    expect(EXCHANGE_TEST_SUPPORT.mexc).toBe(false);
  });
});

describe("Exchange providers supportsTestTrading", () => {
  it("BinanceProvider reports supportsTestTrading", () => {
    expect(new BinanceProvider().supportsTestTrading).toBe(true);
  });
  it("BybitProvider reports supportsTestTrading", () => {
    expect(new BybitProvider().supportsTestTrading).toBe(true);
  });
  it("MexcProvider reports supportsTestTrading false", () => {
    expect(new MexcProvider().supportsTestTrading).toBe(false);
  });
});

describe("ExchangeRouter test trading", () => {
  const env = {
    BINANCE_KEY_BINDING: "binance-key",
    BINANCE_SECRET_BINDING: "binance-secret",
    BYBIT_KEY_BINDING: "bybit-key",
    BYBIT_SECRET_BINDING: "bybit-secret",
    MEXC_KEY_BINDING: "mexc-key",
    MEXC_SECRET_BINDING: "mexc-secret",
  } as any;

  let createBinanceSpy: ReturnType<typeof spyOn>;
  let createBybitSpy: ReturnType<typeof spyOn>;
  let createMexcSpy: ReturnType<typeof spyOn>;

  const mockClient = {
    openLong: () => Promise.resolve({}),
    openShort: () => Promise.resolve({}),
    closeLong: () => Promise.resolve({}),
    closeShort: () => Promise.resolve({}),
    getAccountInfo: () => Promise.resolve({}),
  };

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

  it("routes binance live trades without testnet option", async () => {
    const router = new ExchangeRouter();
    const payload: WebhookPayload = {
      exchange: "binance",
      action: "LONG",
      symbol: "BTCUSDT",
      quantity: 0.01,
    };
    const result = await router.route(payload, env);
    expect(result.testnet).toBe(false);
    expect(createBinanceSpy).toHaveBeenCalledWith(
      "binance-key",
      "binance-secret",
      { testnet: false }
    );
  });

  it("routes binance with test:true as testnet", async () => {
    const router = new ExchangeRouter();
    const payload: WebhookPayload = {
      exchange: "binance",
      action: "LONG",
      symbol: "BTCUSDT",
      quantity: 0.01,
      test: true,
    };
    const result = await router.route(payload, env);
    expect(result.exchange).toBe("binance");
    expect(result.testnet).toBe(true);
    expect(result.useWebsocketDO).toBeFalsy();
    expect(createBinanceSpy).toHaveBeenCalledWith(
      "binance-key",
      "binance-secret",
      { testnet: true }
    );
  });

  it("routes bybit with test:true as testnet", async () => {
    const router = new ExchangeRouter();
    const payload: WebhookPayload = {
      exchange: "bybit",
      action: "SHORT",
      symbol: "ETHUSDT",
      quantity: 1,
      test: true,
    };
    const result = await router.route(payload, env);
    expect(result.testnet).toBe(true);
    expect(createBybitSpy).toHaveBeenCalledWith("bybit-key", "bybit-secret", {
      testnet: true,
    });
  });

  it("rejects mexc test trading", async () => {
    const router = new ExchangeRouter();
    const payload: WebhookPayload = {
      exchange: "mexc",
      action: "LONG",
      symbol: "BTC_USDT",
      quantity: 0.01,
      test: true,
    };
    await expect(router.route(payload, env)).rejects.toThrow(
      "TEST_TRADING_UNSUPPORTED"
    );
    expect(createMexcSpy).not.toHaveBeenCalled();
  });

  it("disables websocket DO when test trading is enabled", async () => {
    const router = new ExchangeRouter();
    const kvEnv = {
      ...env,
      CONFIG_KV: {
        get: async (key: string) => {
          if (key === "exchange:binance:use_websocket") return "true";
          if (key === "exchange:binance:enabled") return "true";
          return null;
        },
      },
    } as any;

    const live = await router.route(
      {
        exchange: "binance",
        action: "LONG",
        symbol: "BTCUSDT",
        quantity: 0.01,
      },
      kvEnv
    );
    expect(live.useWebsocketDO).toBe(true);
    // Perf: live WS path must not construct a REST client.
    expect(live.client).toBeUndefined();
    expect(createBinanceSpy).not.toHaveBeenCalled();

    createBinanceSpy.mockClear();

    const test = await router.route(
      {
        exchange: "binance",
        action: "LONG",
        symbol: "BTCUSDT",
        quantity: 0.01,
        test: true,
      },
      kvEnv
    );
    expect(test.useWebsocketDO).toBe(false);
    expect(test.testnet).toBe(true);
    expect(test.client).toBeDefined();
    expect(createBinanceSpy).toHaveBeenCalledWith(
      "binance-key",
      "binance-secret",
      { testnet: true }
    );
  });

  it("prefers dedicated testnet key bindings when present", async () => {
    const router = new ExchangeRouter();
    const tnEnv = {
      ...env,
      BINANCE_TESTNET_KEY_BINDING: "tn-key",
      BINANCE_TESTNET_SECRET_BINDING: "tn-secret",
    } as any;

    const result = await router.route(
      {
        exchange: "binance",
        action: "LONG",
        symbol: "BTCUSDT",
        quantity: 0.01,
        test: true,
      },
      tnEnv
    );
    expect(result.credentialSource).toBe("testnet");
    expect(createBinanceSpy).toHaveBeenCalledWith("tn-key", "tn-secret", {
      testnet: true,
    });
  });
});
