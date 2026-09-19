/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/src/dex-wallet-client.ts
// Thin IExchangeClient over the web3-wallet-worker service binding.

import {
  authenticatedServiceFetch,
  WALLET_EXECUTE_AUTH_KEY_FIELDS,
  type ServiceBinding,
} from "@hoox-sh/hoox-shared/service-bindings";
import type { IExchangeClient } from "./execution";
import type { Env } from "./index";
import type { DexChain, DexVenue } from "./dex-venues";

export interface CuratedMint {
  mint: string;
  decimals: number;
}

/**
 * Curated human-symbol → mint map. Intentional P1 copy of the wallet
 * worker registry; P4 consolidates into @hoox-sh/hoox-shared.
 */
export const CURATED_MINTS: Record<DexChain, Record<string, CuratedMint>> = {
  ethereum: {
    ETH: {
      mint: "0x0000000000000000000000000000000000000000",
      decimals: 18,
    },
    WETH: {
      mint: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      decimals: 18,
    },
    USDC: {
      mint: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
    },
    USDT: {
      mint: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      decimals: 6,
    },
    DAI: {
      mint: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      decimals: 18,
    },
    WBTC: {
      mint: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      decimals: 8,
    },
  },
  arbitrum: {
    ETH: {
      mint: "0x0000000000000000000000000000000000000000",
      decimals: 18,
    },
    WETH: {
      mint: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      decimals: 18,
    },
    USDC: {
      mint: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      decimals: 6,
    },
    USDT: {
      mint: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      decimals: 6,
    },
  },
  solana: {
    SOL: {
      mint: "So11111111111111111111111111111111111111112",
      decimals: 9,
    },
    USDC: {
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
    },
    USDT: {
      mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      decimals: 6,
    },
  },
};

/** Convert a human quantity to a base-unit integer string without float overflow. */
export function toBaseUnits(quantity: number, decimals: number): string {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error("Quantity must be a non-negative finite number");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }
  const fixed = quantity.toFixed(decimals);
  const [wholeRaw, fracRaw = ""] = fixed.split(".");
  const whole = wholeRaw && wholeRaw.length > 0 ? wholeRaw : "0";
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(`${whole}${frac}`).toString();
}

export class DexWalletClient implements IExchangeClient {
  constructor(
    private readonly binding: ServiceBinding,
    private readonly env: Env,
    private readonly venue: DexVenue
  ) {}

  parsePair(pair: string): { base: string; quote: string } {
    const parts = pair.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error("Invalid DEX pair (expected BASE/QUOTE)");
    }
    return {
      base: parts[0].toUpperCase(),
      quote: parts[1].toUpperCase(),
    };
  }

  private resolveMint(symbol: string): CuratedMint {
    const table = CURATED_MINTS[this.venue.chain];
    const entry = table[symbol.toUpperCase()];
    if (!entry) {
      throw new Error(
        `Unknown token symbol for ${this.venue.chain}: ${symbol}`
      );
    }
    return entry;
  }

  private async postSwap(
    tokenIn: string,
    tokenOut: string,
    amountIn: string
  ): Promise<{ txHash: string }> {
    const body: Record<string, unknown> = {
      chain: this.venue.chain,
      tokenIn,
      tokenOut,
      amountIn,
      slippageBps: 50,
    };
    if (this.venue.defaultDexVersion) {
      body.dexVersion = this.venue.defaultDexVersion;
    }
    const response = await authenticatedServiceFetch(
      this.binding,
      this.env,
      this.venue.walletPath,
      body,
      {
        internalKeyFields: WALLET_EXECUTE_AUTH_KEY_FIELDS,
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Wallet swap failed (${response.status}): ${text || response.statusText}`
      );
    }
    const json = (await response.json()) as { txHash?: string };
    if (!json.txHash) {
      throw new Error("Wallet swap response missing txHash");
    }
    return { txHash: json.txHash };
  }

  async openLong(pair: string, quantity: number): Promise<unknown> {
    const { base, quote } = this.parsePair(pair);
    const quoteMint = this.resolveMint(quote);
    const baseMint = this.resolveMint(base);
    return this.postSwap(
      quoteMint.mint,
      baseMint.mint,
      toBaseUnits(quantity, quoteMint.decimals)
    );
  }

  async openShort(pair: string, quantity: number): Promise<unknown> {
    const { base, quote } = this.parsePair(pair);
    const quoteMint = this.resolveMint(quote);
    const baseMint = this.resolveMint(base);
    return this.postSwap(
      baseMint.mint,
      quoteMint.mint,
      toBaseUnits(quantity, baseMint.decimals)
    );
  }

  closeLong(pair: string, quantity: number): Promise<unknown> {
    return this.openShort(pair, quantity);
  }

  closeShort(pair: string, quantity: number): Promise<unknown> {
    return this.openLong(pair, quantity);
  }

  async getAccountInfo(): Promise<Record<string, unknown>> {
    const response = await authenticatedServiceFetch(
      this.binding,
      this.env,
      "/status",
      undefined,
      {
        method: "GET",
        internalKeyFields: WALLET_EXECUTE_AUTH_KEY_FIELDS,
      }
    );
    if (!response.ok) {
      throw new Error(`Wallet status failed (${response.status})`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    return { address: json.address, venue: this.venue.name };
  }

  async getPositions(_symbol?: string): Promise<unknown> {
    return [];
  }
}
