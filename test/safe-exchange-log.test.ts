/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from "bun:test";
import {
  logExchangeRequest,
  logExchangeResponse,
  sanitizeExchangeUrl,
} from "../src/shared/safe-exchange-log";

describe("safe-exchange-log", () => {
  test("sanitizeExchangeUrl strips query signatures", () => {
    expect(
      sanitizeExchangeUrl(
        "https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT&signature=abc123"
      )
    ).toBe("https://fapi.binance.com/fapi/v1/order");
  });

  test("sanitizeExchangeUrl handles non-URL paths", () => {
    expect(sanitizeExchangeUrl("/v5/order/create?foo=1")).toBe(
      "/v5/order/create"
    );
  });

  test("logExchangeRequest never includes signature material", () => {
    const calls: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const logger = {
      info: (msg: string, ctx?: Record<string, unknown>) => {
        calls.push({ msg, ctx });
      },
    };
    logExchangeRequest(
      logger,
      "Binance",
      "POST",
      "https://fapi.binance.com/fapi/v1/order?signature=deadbeef"
    );
    expect(calls).toHaveLength(1);
    const ctx = calls[0]?.ctx ?? {};
    expect(JSON.stringify(ctx)).not.toContain("signature");
    expect(JSON.stringify(ctx)).not.toContain("deadbeef");
    expect(ctx.path).toBe("https://fapi.binance.com/fapi/v1/order");
    expect(ctx.method).toBe("POST");
  });

  test("logExchangeResponse does not dump body payloads", () => {
    const calls: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const logger = {
      info: (msg: string, ctx?: Record<string, unknown>) => {
        calls.push({ msg, ctx });
      },
      warn: (msg: string, ctx?: Record<string, unknown>) => {
        calls.push({ msg, ctx });
      },
    };
    logExchangeResponse(logger, "Bybit", 200, { ok: true });
    logExchangeResponse(logger, "Bybit", 400, {
      ok: false,
      errorCode: 10001,
      errorMsg: "bad",
    });
    for (const c of calls) {
      expect(c.ctx).not.toHaveProperty("body");
    }
    expect(calls[1]?.msg).toContain("error");
  });
});
