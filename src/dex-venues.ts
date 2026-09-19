/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/src/dex-venues.ts
// P1 spot-venue registry. Perps venues (hyperliquid, gmx-arbitrum,
// jupiter-perps-solana) arrive in P2-P4 and must NOT be added here.

export type DexChain = "ethereum" | "arbitrum" | "solana";

export interface DexVenue {
  /** Exchange name used in signals and `exchange:<name>:enabled` toggles. */
  name: string;
  chain: DexChain;
  kind: "spot";
  /** Wallet worker endpoint (path only, query appended by the client). */
  walletPath: "/swap";
  /** P1 venues are mainnet-only: test flag is rejected fail-closed. */
  supportsTestTrading: false;
  /**
   * Uniswap venues default to V3: Arbitrum's configured V2 router is
   * SushiSwap, and ETH/USDC liquidity lives on V3. Jupiter ignores this.
   */
  defaultDexVersion?: "v2" | "v3";
}

const VENUES: DexVenue[] = [
  {
    name: "uniswap-ethereum",
    chain: "ethereum",
    kind: "spot",
    walletPath: "/swap",
    supportsTestTrading: false,
    defaultDexVersion: "v3",
  },
  {
    name: "uniswap-arbitrum",
    chain: "arbitrum",
    kind: "spot",
    walletPath: "/swap",
    supportsTestTrading: false,
    defaultDexVersion: "v3",
  },
  {
    name: "jupiter-solana",
    chain: "solana",
    kind: "spot",
    walletPath: "/swap",
    supportsTestTrading: false,
  },
];

export const DEX_VENUES: Record<string, DexVenue> = Object.fromEntries(
  VENUES.map((v) => [v.name, v])
);

export const DEX_VENUE_NAMES = VENUES.map((v) => v.name);

export function resolveDexVenue(name: string): DexVenue | undefined {
  return DEX_VENUES[name.toLowerCase()];
}
