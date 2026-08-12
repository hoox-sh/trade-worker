/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolve exchange API credentials for live or testnet trading.
 *
 * Preferred (unified) secrets — one key/secret pair for whichever exchange
 * the operator trades on (selected via signal/routing, not via secret name):
 *   EXCHANGE_KEY_BINDING / EXCHANGE_SECRET_BINDING
 * Optional testnet pair:
 *   EXCHANGE_TESTNET_KEY_BINDING / EXCHANGE_TESTNET_SECRET_BINDING
 *
 * Legacy per-exchange bindings (BINANCE_*, BYBIT_*, MEXC_*) remain as
 * fallbacks so existing deployments keep working until secrets are migrated.
 */

/** Canonical unified secret names (trade-worker wrangler / CLI catalogs). */
export const EXCHANGE_KEY_BINDING = "EXCHANGE_KEY_BINDING" as const;
export const EXCHANGE_SECRET_BINDING = "EXCHANGE_SECRET_BINDING" as const;
export const EXCHANGE_TESTNET_KEY_BINDING =
  "EXCHANGE_TESTNET_KEY_BINDING" as const;
export const EXCHANGE_TESTNET_SECRET_BINDING =
  "EXCHANGE_TESTNET_SECRET_BINDING" as const;

export interface CredentialEnv {
  /** Unified live API key (preferred). */
  EXCHANGE_KEY_BINDING?: string;
  EXCHANGE_SECRET_BINDING?: string;
  /** Unified testnet API key (preferred when test:true). */
  EXCHANGE_TESTNET_KEY_BINDING?: string;
  EXCHANGE_TESTNET_SECRET_BINDING?: string;
  /** @deprecated Prefer EXCHANGE_KEY_BINDING */
  BINANCE_KEY_BINDING?: string;
  /** @deprecated Prefer EXCHANGE_SECRET_BINDING */
  BINANCE_SECRET_BINDING?: string;
  /** @deprecated Prefer EXCHANGE_TESTNET_KEY_BINDING */
  BINANCE_TESTNET_KEY_BINDING?: string;
  /** @deprecated Prefer EXCHANGE_TESTNET_SECRET_BINDING */
  BINANCE_TESTNET_SECRET_BINDING?: string;
  /** @deprecated Prefer EXCHANGE_KEY_BINDING */
  BYBIT_KEY_BINDING?: string;
  /** @deprecated Prefer EXCHANGE_SECRET_BINDING */
  BYBIT_SECRET_BINDING?: string;
  /** @deprecated Prefer EXCHANGE_TESTNET_KEY_BINDING */
  BYBIT_TESTNET_KEY_BINDING?: string;
  /** @deprecated Prefer EXCHANGE_TESTNET_SECRET_BINDING */
  BYBIT_TESTNET_SECRET_BINDING?: string;
  /** @deprecated Prefer EXCHANGE_KEY_BINDING */
  MEXC_KEY_BINDING?: string;
  /** @deprecated Prefer EXCHANGE_SECRET_BINDING */
  MEXC_SECRET_BINDING?: string;
}

export type CredentialSource = "testnet" | "live";

export interface ResolvedCredentials {
  apiKey: string;
  apiSecret: string;
  /** Which binding pair was used. */
  source: CredentialSource;
}

function pair(
  key?: string,
  secret?: string
): { apiKey: string; apiSecret: string } | null {
  if (key && secret) return { apiKey: key, apiSecret: secret };
  return null;
}

const SUPPORTED = new Set(["binance", "bybit", "mexc"]);

/**
 * Returns true when the exchange has usable credentials for the requested mode.
 * Testnet mode accepts either dedicated testnet keys or live-key fallback.
 */
export function hasExchangeCredentials(
  exchange: string,
  env: CredentialEnv,
  testnet = false
): boolean {
  return resolveExchangeCredentials(exchange, env, testnet) !== null;
}

/**
 * Resolve key/secret for an exchange. Returns null when nothing usable is set.
 *
 * Order (testnet=true):
 *   1. Unified EXCHANGE_TESTNET_*
 *   2. Legacy per-exchange TESTNET_* (binance/bybit only)
 *   3. Unified EXCHANGE_* (live fallback)
 *   4. Legacy per-exchange live bindings
 *
 * Order (testnet=false):
 *   1. Unified EXCHANGE_*
 *   2. Legacy per-exchange live bindings
 */
export function resolveExchangeCredentials(
  exchange: string,
  env: CredentialEnv,
  testnet = false
): ResolvedCredentials | null {
  const ex = exchange.toLowerCase();
  if (!SUPPORTED.has(ex)) return null;

  if (testnet) {
    const unifiedTn = pair(
      env.EXCHANGE_TESTNET_KEY_BINDING,
      env.EXCHANGE_TESTNET_SECRET_BINDING
    );
    if (unifiedTn) return { ...unifiedTn, source: "testnet" };

    const legacyTn = resolveLegacyTestnet(ex, env);
    if (legacyTn) return { ...legacyTn, source: "testnet" };
  }

  const unifiedLive = pair(
    env.EXCHANGE_KEY_BINDING,
    env.EXCHANGE_SECRET_BINDING
  );
  if (unifiedLive) return { ...unifiedLive, source: "live" };

  const legacyLive = resolveLegacyLive(ex, env);
  return legacyLive ? { ...legacyLive, source: "live" } : null;
}

function resolveLegacyTestnet(
  ex: string,
  env: CredentialEnv
): { apiKey: string; apiSecret: string } | null {
  if (ex === "binance") {
    return pair(
      env.BINANCE_TESTNET_KEY_BINDING,
      env.BINANCE_TESTNET_SECRET_BINDING
    );
  }
  if (ex === "bybit") {
    return pair(env.BYBIT_TESTNET_KEY_BINDING, env.BYBIT_TESTNET_SECRET_BINDING);
  }
  // MEXC has no public REST testnet
  return null;
}

function resolveLegacyLive(
  ex: string,
  env: CredentialEnv
): { apiKey: string; apiSecret: string } | null {
  if (ex === "binance") {
    return pair(env.BINANCE_KEY_BINDING, env.BINANCE_SECRET_BINDING);
  }
  if (ex === "bybit") {
    return pair(env.BYBIT_KEY_BINDING, env.BYBIT_SECRET_BINDING);
  }
  if (ex === "mexc") {
    return pair(env.MEXC_KEY_BINDING, env.MEXC_SECRET_BINDING);
  }
  return null;
}
