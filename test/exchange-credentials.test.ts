/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "bun:test";
import {
  hasExchangeCredentials,
  resolveExchangeCredentials,
} from "../src/exchange-credentials";

describe("resolveExchangeCredentials", () => {
  it("prefers dedicated binance testnet keys when testnet=true", () => {
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

  it("falls back to live binance keys when testnet keys missing", () => {
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

  it("uses live keys when testnet=false even if testnet keys exist", () => {
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

  it("returns null when no usable credentials", () => {
    expect(resolveExchangeCredentials("binance", {}, true)).toBeNull();
    expect(resolveExchangeCredentials("mexc", {}, false)).toBeNull();
  });

  it("hasExchangeCredentials reflects availability", () => {
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
