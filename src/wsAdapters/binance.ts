/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/src/wsAdapters/binance.ts
//
// Binance WS API v3 adapter.
// Docs: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-api
//
// Auth model: each request carries the apiKey and an HMAC-SHA256 signature
// over the canonical query string (sorted params, URL-encoded, signed
// with the apiSecret). `buildRequest` is async because WebCrypto's
// `crypto.subtle.sign` is promise-based.
//
// Response shape: { id, status, result? | error? }

import type { IWsAdapter, WsResponse } from "./types";

/**
 * Sort an object's keys and stringify values for canonical signing.
 * Matches the Binance "signed" example: keys in alphabetical order, values
 * as strings, joined by `&`.
 */
function sortedParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * HMAC-SHA256 sign the canonical query string. Returns lowercase hex.
 */
async function sign(secret: string, query: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(query));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class BinanceAdapter implements IWsAdapter {
  readonly url = "wss://ws-api.binance.com:443/ws-api/v3";

  constructor(private readonly creds: { apiKey: string; apiSecret: string }) {}

  async buildRequest(
    method: string,
    params: Record<string, unknown>
  ): Promise<string> {
    const id = crypto.randomUUID();
    const flat = sortedParams({
      apiKey: this.creds.apiKey,
      timestamp: Date.now(),
      ...params,
    });
    const query = new URLSearchParams(flat).toString();
    const signature = await sign(this.creds.apiSecret, query);

    return JSON.stringify({
      id,
      method,
      params: { ...flat, signature },
    });
  }

  parseResponse(raw: string): WsResponse | null {
    let msg: {
      id?: unknown;
      status?: unknown;
      result?: unknown;
      error?: { code?: unknown; msg?: unknown };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!msg || typeof msg.id !== "string") return null; // push event
    if (msg.error) {
      return {
        id: msg.id,
        error: {
          code: Number(msg.error.code ?? 0),
          msg: String(msg.error.msg ?? ""),
        },
      };
    }
    return { id: msg.id, result: msg.result };
  }
}
