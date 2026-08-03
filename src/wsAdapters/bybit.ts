/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/src/wsAdapters/bybit.ts
//
// Bybit V5 private stream adapter.
// Docs: https://bybit-exchange.github.io/docs/v5/ws/private/connect
//
// Auth model: a one-time signed `auth` op sent after connect (handled by
// the DO's connect logic, out of scope for the adapter). For trade
// execution the adapter uses `op: "order.create"` request/response.
//
// Response shape: { reqId, op, retCode, retMsg, result }

import type { IWsAdapter, WsResponse } from "./types";

export class BybitAdapter implements IWsAdapter {
  readonly url = "wss://api.bybit.com/v5/private";

  // Creds are accepted for interface conformance (signing is done at
  // connect time, not per request). Stored for future use if per-request
  // signing becomes necessary.
  constructor(private readonly creds: { apiKey: string; apiSecret: string }) {
    // Reference creds to silence "unused private field" lints; the field
    // exists for interface conformance and future per-request signing.
    void this.creds;
  }

  async buildRequest(
    method: string,
    params: Record<string, unknown>
  ): Promise<string> {
    const reqId = crypto.randomUUID();
    return JSON.stringify({
      reqId,
      op: method, // e.g. "order.create"
      args: params,
    });
  }

  parseResponse(raw: string): WsResponse | null {
    let msg: {
      reqId?: unknown;
      retCode?: unknown;
      retMsg?: unknown;
      result?: unknown;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!msg || typeof msg.reqId !== "string") return null; // push event
    if (msg.retCode !== undefined && msg.retCode !== 0) {
      return {
        id: msg.reqId,
        error: { code: Number(msg.retCode), msg: String(msg.retMsg ?? "") },
      };
    }
    return { id: msg.reqId, result: msg.result };
  }
}
