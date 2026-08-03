/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/src/wsAdapters/adapters.ts
//
// Per-exchange adapter factory. Add a new exchange by writing an adapter
// class and registering its factory here.
//
// Each call returns a fresh instance so the caller (typically a Durable
// Object) binds its own credentials to the adapter. Sharing instances
// across DOs would leak credentials between isolated connections.

import { BinanceAdapter } from "./binance";
import { BybitAdapter } from "./bybit";
import { MexcAdapter } from "./mexc";
import type { IWsAdapter } from "./types";

type AdapterCtor = new (creds: {
  apiKey: string;
  apiSecret: string;
}) => IWsAdapter;

const REGISTRY: Record<string, AdapterCtor> = {
  binance: BinanceAdapter,
  bybit: BybitAdapter,
  mexc: MexcAdapter,
};

/**
 * Construct a configured WS adapter for the given exchange.
 *
 * @param exchange Exchange name (case-insensitive)
 * @param creds    API key/secret to bind to the adapter
 * @returns        A fresh adapter instance, or `undefined` if the exchange
 *                 has no registered adapter.
 */
export function getAdapter(
  exchange: string,
  creds: { apiKey: string; apiSecret: string }
): IWsAdapter | undefined {
  const Ctor = REGISTRY[exchange.toLowerCase()];
  return Ctor ? new Ctor(creds) : undefined;
}
