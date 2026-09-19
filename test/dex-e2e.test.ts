/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, mock } from "bun:test";
import { ExchangeRouter } from "../src/exchange-router";

describe("DEX e2e routing", () => {
  it("routes uniswap-ethereum to the wallet binding", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const env: any = {
      INTERNAL_KEY_BINDING: "test-internal-key",
      CONFIG_KV: {
        get: mock(async () => null),
        put: mock(async () => undefined),
      },
      WEB3_WALLET_SERVICE: {
        fetch: mock(async (url: any, init?: any) => {
          calls.push({
            url: String(url),
            body: JSON.parse(String(init?.body)),
          });
          return new Response(
            JSON.stringify({ txHash: "0xe2e", id: "e2e-1" }),
            { status: 200 }
          );
        }),
      },
    };
    const router = new ExchangeRouter();
    const route = await router.route(
      {
        exchange: "uniswap-ethereum",
        action: "LONG",
        symbol: "ETH/USDC",
        quantity: 10,
      } as any,
      env
    );
    const res: any = await route.client!.openLong("ETH/USDC", 10);
    expect(res.txHash).toBe("0xe2e");
    expect(calls[0]?.url).toBe("http://internal/swap");
    expect((calls[0]?.body as any).chain).toBe("ethereum");
  });

  it("rejects the test flag on mainnet-only venues", async () => {
    const env: any = {
      CONFIG_KV: { get: mock(async () => null) },
      WEB3_WALLET_SERVICE: { fetch: mock(async () => new Response("{}")) },
    };
    const router = new ExchangeRouter();
    await expect(
      router.route(
        {
          exchange: "jupiter-solana",
          action: "LONG",
          symbol: "SOL/USDC",
          quantity: 1,
          test: true,
        } as any,
        env
      )
    ).rejects.toThrow(/TEST_TRADING_UNSUPPORTED/);
  });
});
