/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from "bun:test";
import { validateSignalPayload } from "../src/signals";

describe("validateSignalPayload", () => {
  const valid = {
    symbol: "BTCUSDT",
    signal_type: "BUY",
    timestamp: 1_700_000_000,
    source: "unit-test",
  };

  it("accepts a valid payload", () => {
    expect(validateSignalPayload(valid)).toBeNull();
  });

  it("rejects missing required fields", () => {
    expect(validateSignalPayload({ symbol: "X" })).toMatch(/Missing required/);
    expect(
      validateSignalPayload({ signal_type: "BUY", timestamp: 1 })
    ).toMatch(/Missing required/);
  });

  it("rejects non-string symbol", () => {
    expect(
      validateSignalPayload({ ...valid, symbol: 123 as unknown as string })
    ).toMatch(/symbol/);
  });

  it("rejects empty or oversized symbol", () => {
    expect(validateSignalPayload({ ...valid, symbol: "" })).toMatch(/symbol/);
    expect(validateSignalPayload({ ...valid, symbol: "x".repeat(33) })).toMatch(
      /symbol/
    );
  });

  it("rejects disallowed symbol characters", () => {
    expect(
      validateSignalPayload({ ...valid, symbol: "BTC<script>" })
    ).toMatch(/disallowed/);
  });

  it("rejects invalid signal_type", () => {
    expect(
      validateSignalPayload({
        ...valid,
        signal_type: 1 as unknown as string,
      })
    ).toMatch(/signal_type/);
    expect(
      validateSignalPayload({ ...valid, signal_type: "x".repeat(40) })
    ).toMatch(/signal_type/);
  });

  it("rejects invalid timestamp", () => {
    expect(validateSignalPayload({ ...valid, timestamp: 0 })).toMatch(
      /timestamp/
    );
    expect(validateSignalPayload({ ...valid, timestamp: NaN })).toMatch(
      /timestamp/
    );
    expect(
      validateSignalPayload({
        ...valid,
        timestamp: "now" as unknown as number,
      })
    ).toMatch(/timestamp/);
  });

  it("rejects oversized source", () => {
    expect(
      validateSignalPayload({ ...valid, source: "s".repeat(200) })
    ).toMatch(/source/);
  });

  it("allows omitted source", () => {
    const { source: _s, ...rest } = valid;
    expect(validateSignalPayload(rest)).toBeNull();
  });
});
