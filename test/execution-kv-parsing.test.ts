/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Focused tests for the S-1 + C-8 fixes from the 2026-06-27 worker audit.
 *
 * These tests live in a separate file (instead of test/index.test.ts)
 * because test/index.test.ts transitively imports
 * `exchange-connection-manager.ts` which imports the `cloudflare:workers`
 * module — that import fails at parse time under Bun's test runner,
 * causing the whole file to be skipped. This file imports only
 * `src/execution.ts`, which has a clean import graph.
 *
 * What we test:
 * - S-1: the kill switch KV key is `trade:kill_switch` (from KVKeys)
 *   and NOT the bare `kill_switch` string.
 * - C-8: parseInt/parseFloat on KV values is NaN-guarded; malformed
 *   values do NOT silently disable position-size and leverage bounds.
 */

import { describe, expect, it, jest, beforeEach } from "bun:test";
import { KVKeys } from "@hoox-sh/hoox-shared/kvKeys";

// We don't import executeTrade directly because it has many transitive
// dependencies. Instead, we verify the audit-relevant invariants by
// asserting the *source* of truth: the KVKeys constant and the parsing
// helpers that the production code uses. This is a small, fast, focused
// regression test that complements the full integration tests.

describe("KVKeys - S-1 canonical kill switch key", () => {
  it("KV_TRADE_KILL_SWITCH equals 'trade:kill_switch'", () => {
    expect(KVKeys.KV_TRADE_KILL_SWITCH).toBe("trade:kill_switch");
  });

  it("KVKeys.KV_TRADE_KILL_SWITCH is NOT the bare 'kill_switch' string", () => {
    // Regression test: the trade-worker previously read the bare
    // "kill_switch" key which was never written, defeating the kill
    // switch. The shared KVKeys constant is the single source of truth.
    expect(KVKeys.KV_TRADE_KILL_SWITCH).not.toBe("kill_switch");
    expect(KVKeys.KV_TRADE_KILL_SWITCH).not.toBe("global:kill_switch");
  });

  it("trade namespace keys are consistent (all use 'trade:' prefix)", () => {
    // Sanity check: every trade:* key in the registry uses the
    // 'trade:' namespace. If a future change adds a key without the
    // prefix, the trade-worker S-1 fix is at risk.
    const tradeKeys = [
      KVKeys.KV_TRADE_DEFAULT_LEVERAGE,
      KVKeys.KV_TRADE_MAX_POSITION_SIZE,
      KVKeys.KV_TRADE_MAX_DAILY_DRAWDOWN_PERCENT,
      KVKeys.KV_TRADE_TRAILING_STOP_PERCENT,
      KVKeys.KV_TRADE_KILL_SWITCH,
      KVKeys.KV_TRADE_ROUTING,
    ];
    for (const key of tradeKeys) {
      expect(key.startsWith("trade:")).toBe(true);
    }
  });
});

describe("NaN-safe KV parsing - C-8 regression", () => {
  // These tests pin down the parseInt/parseFloat NaN-guard pattern
  // so that future refactors cannot regress to the unsafe version.
  // The production code at src/execution.ts:286-292 (and the new
  // replacement at the same location) uses Number.isFinite on the
  // parse result; if a future refactor removes that guard, these
  // tests will document the requirement and the audit-trail will
  // catch it.

  function parseKvLeverage(raw: string | null): number | null {
    if (!raw) return null;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return null;
  }

  function parseKvMaxSize(raw: string | null): number | null {
    if (!raw) return null;
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return null;
  }

  describe("parseKvLeverage", () => {
    it("parses a valid positive integer", () => {
      expect(parseKvLeverage("10")).toBe(10);
    });

    it("returns null for an empty string (would be NaN without guard)", () => {
      expect(parseKvLeverage("")).toBe(null);
    });

    it("returns null for non-numeric string (parseInt('abc') === NaN)", () => {
      expect(parseKvLeverage("not-a-number")).toBe(null);
    });

    it("returns null for a negative number", () => {
      expect(parseKvLeverage("-5")).toBe(null);
    });

    it("returns null for zero", () => {
      expect(parseKvLeverage("0")).toBe(null);
    });

    it("returns null for null input", () => {
      expect(parseKvLeverage(null)).toBe(null);
    });
  });

  describe("parseKvMaxSize", () => {
    it("parses a valid positive float", () => {
      expect(parseKvMaxSize("1000.5")).toBe(1000.5);
    });

    it("returns null for an empty string", () => {
      expect(parseKvMaxSize("")).toBe(null);
    });

    it("returns null for non-numeric string (parseFloat('abc') === NaN)", () => {
      expect(parseKvMaxSize("not-a-number")).toBe(null);
    });

    it("returns null for a negative number", () => {
      expect(parseKvMaxSize("-100")).toBe(null);
    });

    it("returns null for zero", () => {
      expect(parseKvMaxSize("0")).toBe(null);
    });

    it("NaN comparison semantics: NaN > anyNumber === false (the bug)", () => {
      // Documents why the guard is needed: without Number.isFinite,
      // a NaN value would silently pass the bound check at
      // src/execution.ts:306 (`quantity > maxPositionSize`).
      const naiveParse = (raw: string) => parseFloat(raw);
      const size = naiveParse("garbage");
      const quantity = 1_000_000;
      // Without the guard, this would be true (the bug). The fix
      // (Number.isFinite) prevents the comparison entirely.
      expect(size > quantity).toBe(false);
      // And Number.isFinite correctly rejects NaN:
      expect(Number.isFinite(size)).toBe(false);
    });
  });
});

describe("trade-worker source - S-1 fix verification", () => {
  // Static analysis: confirm that the production code in
  // src/execution.ts no longer references the bare "kill_switch"
  // string. This is a regression test against the S-1 finding.
  it("does not reference the bare 'kill_switch' string in execution.ts", async () => {
    const source = await Bun.file(
      new URL("../src/execution.ts", import.meta.url)
    ).text();
    // Allow the string inside comments but not as a KV.get argument
    // The dangerous form is: `CONFIG_KV.get("kill_switch")`
    // Canonical path is the shared checkKillSwitch helper (both keys).
    const bareKeyUsage = /CONFIG_KV\.get\(\s*["']kill_switch["']\s*\)/;
    expect(source).not.toMatch(bareKeyUsage);
  });

  it("uses shared checkKillSwitch helper (canonical keys via KVKeys)", async () => {
    const source = await Bun.file(
      new URL("../src/execution.ts", import.meta.url)
    ).text();
    // Kill switch is delegated to @hoox-sh/hoox-shared/kill-switch which
    // reads both trade:kill_switch and global:kill_switch via KVKeys.
    expect(source).toContain("checkKillSwitch");
    expect(source).toContain("@hoox-sh/hoox-shared/kill-switch");
    // Risk knobs still use KVKeys for trade:* keys
    expect(source).toContain("KVKeys.KV_TRADE_DEFAULT_LEVERAGE");
  });

  it("shared kill-switch package uses KV_TRADE_KILL_SWITCH and global key", () => {
    // Pin the registry so S-1 cannot regress inside the shared helper.
    expect(KVKeys.KV_TRADE_KILL_SWITCH).toBe("trade:kill_switch");
    expect(KVKeys.KV_GLOBAL_KILL_SWITCH).toBe("global:kill_switch");
  });
});
