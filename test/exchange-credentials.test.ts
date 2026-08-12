/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "bun:test";
import {
  hasExchangeCredentials,
  resolveExchangeCredentials,
} from "../src/exchange-credentials";

describe("resolveExchangeCredentials — unified EXCHANGE_*", () => {
  it("uses unified live keys for any supported exchange", () => {
    const env = {
      EXCHANGE_KEY_BINDING: "uni-key",
      EXCHANGE_SECRET_BINDING: "uni-secret",
    };
    for (const ex of ["binance", "bybit", "mexc"] as const) {
      expect(resolveExchangeCredentials(ex, env, false)).toEqual({
        apiKey: "uni-key",
        apiSecret: "uni-secret",
        source: "live",
      });
    }
  });

  it("prefers unified testnet keys when testnet=true", () => {
    const creds = resolveExchangeCredentials(
      "binance",
      {
        EXCHANGE_KEY_BINDING: "live-key",
        EXCHANGE_SECRET_BINDING: "live-secret",
        EXCHANGE_TESTNET_KEY_BINDING: "tn-key",
        EXCHANGE_TESTNET_SECRET_BINDING: "tn-secret",
      },
      true
    );
    expect(creds).toEqual({
      apiKey: "tn-key",
      apiSecret: "tn-secret",
      source: "testnet",
    });
  });

  it("falls back to unified live keys when testnet pair missing", () => {
    const creds = resolveExchangeCredentials(
      "bybit",
      {
        EXCHANGE_KEY_BINDING: "live-key",
        EXCHANGE_SECRET_BINDING: "live-secret",
      },
      true
    );
    expect(creds).toEqual({
      apiKey: "live-key",
      apiSecret: "live-secret",
      source: "live",
    });
  });

  it("uses live keys when testnet=false even if testnet keys exist", () => {
    const creds = resolveExchangeCredentials(
      "bybit",
      {
        EXCHANGE_KEY_BINDING: "live-key",
        EXCHANGE_SECRET_BINDING: "live-secret",
        EXCHANGE_TESTNET_KEY_BINDING: "tn-key",
        EXCHANGE_TESTNET_SECRET_BINDING: "tn-secret",
      },
      false
    );
    expect(creds?.source).toBe("live");
    expect(creds?.apiKey).toBe("live-key");
  });
});

describe("resolveExchangeCredentials — legacy fallback", () => {
  it("prefers dedicated binance testnet keys when unified missing", () => {
    const creds = resolveExchangeCredentials(
      "binance",
      {
        BINANCE_KEY_BINDING: "live-key",
        BINANCE_SECRET_BINDING: "live-secret",
        BINANCE_TESTNET_KEY_BINDING: "tn-key",
        BINANCE_TESTNET_SECRET_BINDING: "tn-secret",
      },
      true
    );
    expect(creds).toEqual({
      apiKey: "tn-key",
      apiSecret: "tn-secret",
      source: "testnet",
    });
  });

  it("falls back to legacy live binance keys", () => {
    const creds = resolveExchangeCredentials(
      "binance",
      {
        BINANCE_KEY_BINDING: "live-key",
        BINANCE_SECRET_BINDING: "live-secret",
      },
      true
    );
    expect(creds).toEqual({
      apiKey: "live-key",
      apiSecret: "live-secret",
      source: "live",
    });
  });

  it("uses legacy bybit live when testnet=false", () => {
    const creds = resolveExchangeCredentials(
      "bybit",
      {
        BYBIT_KEY_BINDING: "live-key",
        BYBIT_SECRET_BINDING: "live-secret",
        BYBIT_TESTNET_KEY_BINDING: "tn-key",
        BYBIT_TESTNET_SECRET_BINDING: "tn-secret",
      },
      false
    );
    expect(creds?.source).toBe("live");
    expect(creds?.apiKey).toBe("live-key");
  });

  it("unified takes precedence over legacy", () => {
    const creds = resolveExchangeCredentials(
      "binance",
      {
        EXCHANGE_KEY_BINDING: "uni",
        EXCHANGE_SECRET_BINDING: "unisec",
        BINANCE_KEY_BINDING: "legacy",
        BINANCE_SECRET_BINDING: "legacysec",
      },
      false
    );
    expect(creds?.apiKey).toBe("uni");
  });

  it("returns null when no usable credentials", () => {
    expect(resolveExchangeCredentials("binance", {}, true)).toBeNull();
    expect(resolveExchangeCredentials("mexc", {}, false)).toBeNull();
    expect(resolveExchangeCredentials("unknown", {}, false)).toBeNull();
  });

  it("hasExchangeCredentials reflects availability", () => {
    expect(
      hasExchangeCredentials(
        "bybit",
        { EXCHANGE_TESTNET_KEY_BINDING: "k", EXCHANGE_TESTNET_SECRET_BINDING: "s" },
        true
      )
    ).toBe(true);
    expect(
      hasExchangeCredentials(
        "bybit",
        { BYBIT_TESTNET_KEY_BINDING: "k", BYBIT_TESTNET_SECRET_BINDING: "s" },
        true
      )
    ).toBe(true);
    expect(hasExchangeCredentials("bybit", {}, true)).toBe(false);
  });
});
