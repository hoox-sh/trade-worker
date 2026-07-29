/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

export type ExchangeName = "binance" | "mexc" | "bybit";

export interface ExchangeConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  testnet?: boolean;
}

export interface TradeParams {
  symbol: string;
  side: "long" | "short";
  orderType?: string;
  quantity: number;
  price?: number;
  reduceOnly?: boolean;
  leverage?: number;
}

export interface OrderResponse {
  orderId: string;
  symbol: string;
  status: string;
  executedQty?: string;
  price?: string;
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  unrealizedPnl?: number;
}

/**
 * Convert an ArrayBuffer to a hex string.
 * Used by all exchange clients for HMAC-SHA256 signature generation.
 * Extracted to eliminate the same 3-line pattern in 3 client files.
 */
export function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sign data with HMAC-SHA256 using the Web Crypto API.
 * Shared utility to eliminate duplicated crypto.subtle patterns across exchange clients.
 */
export async function hmacSign(secret: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const importedKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    importedKey,
    encoder.encode(data)
  );
  return bufferToHex(signatureBuffer);
}
