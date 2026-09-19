/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from "bun:test";
import {
  DEX_VENUES,
  DEX_VENUE_NAMES,
  resolveDexVenue,
} from "../src/dex-venues";

describe("dex-venues", () => {
  it("registers exactly the P1 spot venues", () => {
    expect([...DEX_VENUE_NAMES].sort()).toEqual([
      "jupiter-solana",
      "uniswap-arbitrum",
      "uniswap-ethereum",
    ]);
  });

  it("resolves case-insensitively", () => {
    expect(resolveDexVenue("Uniswap-Ethereum")?.chain).toBe("ethereum");
  });

  it("returns undefined for CEX names and perps venues", () => {
    expect(resolveDexVenue("binance")).toBeUndefined();
    expect(resolveDexVenue("hyperliquid")).toBeUndefined();
  });

  it("marks all P1 venues as mainnet-only for the test flag", () => {
    for (const name of DEX_VENUE_NAMES) {
      expect(DEX_VENUES[name]?.supportsTestTrading).toBe(false);
    }
  });

  it("defaults Uniswap venues to v3", () => {
    expect(DEX_VENUES["uniswap-ethereum"]?.defaultDexVersion).toBe("v3");
    expect(DEX_VENUES["uniswap-arbitrum"]?.defaultDexVersion).toBe("v3");
    expect(DEX_VENUES["jupiter-solana"]?.defaultDexVersion).toBeUndefined();
  });
});
