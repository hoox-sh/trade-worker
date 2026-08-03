/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolve exchange API credentials for live or testnet trading.
 *
 * When `testnet` is true, prefer dedicated `*_TESTNET_*` secret bindings
 * if both key and secret are present; otherwise fall back to the live
 * bindings (legacy shared-key deployments).
 */

export interface CredentialEnv {
  BINANCE_KEY_BINDING?: string;
  BINANCE_SECRET_BINDING?: string;
  BINANCE_TESTNET_KEY_BINDING?: string;
  BINANCE_TESTNET_SECRET_BINDING?: string;
  BYBIT_KEY_BINDING?: string;
  BYBIT_SECRET_BINDING?: string;
  BYBIT_TESTNET_KEY_BINDING?: string;
  BYBIT_TESTNET_SECRET_BINDING?: string;
  MEXC_KEY_BINDING?: string;
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
 */
export function resolveExchangeCredentials(
  exchange: string,
  env: CredentialEnv,
  testnet = false
): ResolvedCredentials | null {
  const ex = exchange.toLowerCase();

  if (ex === "binance") {
    if (testnet) {
      const dedicated = pair(
        env.BINANCE_TESTNET_KEY_BINDING,
        env.BINANCE_TESTNET_SECRET_BINDING
      );
      if (dedicated) return { ...dedicated, source: "testnet" };
    }
    const live = pair(env.BINANCE_KEY_BINDING, env.BINANCE_SECRET_BINDING);
    return live ? { ...live, source: "live" } : null;
  }

  if (ex === "bybit") {
    if (testnet) {
      const dedicated = pair(
        env.BYBIT_TESTNET_KEY_BINDING,
        env.BYBIT_TESTNET_SECRET_BINDING
      );
      if (dedicated) return { ...dedicated, source: "testnet" };
    }
    const live = pair(env.BYBIT_KEY_BINDING, env.BYBIT_SECRET_BINDING);
    return live ? { ...live, source: "live" } : null;
  }

  if (ex === "mexc") {
    // MEXC has no public REST testnet — only live bindings.
    const live = pair(env.MEXC_KEY_BINDING, env.MEXC_SECRET_BINDING);
    return live ? { ...live, source: "live" } : null;
  }

  return null;
}
