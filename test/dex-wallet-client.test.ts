/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, mock } from "bun:test";
import { DexWalletClient, toBaseUnits } from "../src/dex-wallet-client";
import { DEX_VENUES } from "../src/dex-venues";

function mockBinding(handler: (url: string, init?: RequestInit) => Response) {
  return {
    fetch: mock(async (url: any, init?: any) => handler(String(url), init)),
  };
}

const env: any = { INTERNAL_KEY_BINDING: "test-internal-key" };

describe("DexWalletClient", () => {
  it("rejects malformed pairs", () => {
    const c = new DexWalletClient(
      mockBinding(() => new Response("{}")) as any,
      env,
      DEX_VENUES["uniswap-ethereum"]!
    );
    expect(() => c.parsePair("!!!")).toThrow(/BASE\/QUOTE/);
    expect(() => c.parsePair("ETH")).toThrow(/BASE\/QUOTE/);
    expect(() => c.parsePair("")).toThrow(/BASE\/QUOTE/);
  });

  it("normalizes dash/underscore/concatenated pairs", () => {
    const c = new DexWalletClient(
      mockBinding(() => new Response("{}")) as any,
      env,
      DEX_VENUES["uniswap-ethereum"]!
    );
    expect(c.parsePair("ETH-USDC")).toEqual({ base: "ETH", quote: "USDC" });
    expect(c.parsePair("ETH_USDC")).toEqual({ base: "ETH", quote: "USDC" });
    expect(c.parsePair("ETHUSDC")).toEqual({ base: "ETH", quote: "USDC" });
    const sol = new DexWalletClient(
      mockBinding(() => new Response("{}")) as any,
      env,
      DEX_VENUES["jupiter-solana"]!
    );
    expect(sol.parsePair("SOLUSDC")).toEqual({ base: "SOL", quote: "USDC" });
  });

  it("openLong spends quote to buy base via POST /swap", async () => {
    let seenUrl = "";
    let seenBody: any = null;
    let seenHeaders: any = null;
    const binding = mockBinding((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body));
      seenHeaders = init?.headers;
      return new Response(JSON.stringify({ txHash: "0xok", id: "1" }), {
        status: 200,
      });
    });
    const c = new DexWalletClient(
      binding as any,
      env,
      DEX_VENUES["uniswap-ethereum"]!
    );
    const res: any = await c.openLong("ETH/USDC", 100);
    expect(seenUrl).toBe("http://internal/swap");
    expect(seenBody).toMatchObject({
      chain: "ethereum",
      amountIn: "100000000",
      dexVersion: "v3",
      slippageBps: 50,
    });
    expect(seenBody.tokenIn).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(seenHeaders["X-Internal-Auth-Key"]).toBe("test-internal-key");
    expect(String(seenHeaders["Idempotency-Key"]).length).toBeGreaterThan(0);
    expect(res.txHash).toBe("0xok");
  });

  it("getPositions returns [] for spot venues", async () => {
    const c = new DexWalletClient(
      mockBinding(() => new Response("{}")) as any,
      env,
      DEX_VENUES["jupiter-solana"]!
    );
    expect(await c.getPositions()).toEqual([]);
  });

  it("toBaseUnits avoids float overflow on 18-decimal quantities", () => {
    expect(toBaseUnits(100, 6)).toBe("100000000");
    expect(toBaseUnits(0.5, 18)).toBe("500000000000000000");
    expect(toBaseUnits(100, 18)).toBe("100000000000000000000");
  });
});
