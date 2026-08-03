/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/src/wsAdapters/types.ts
//
// Shared interface for per-exchange WebSocket adapters.
// Each adapter wraps one exchange's WS API (URL + envelope) behind a
// uniform shape so the DO doesn't need exchange-specific code.
// Credentials are bound at adapter construction (mirroring REST clients
// like `BaseExchangeClient` / `BinanceClient`); a WS connection speaks
// for one credential set for its lifetime.

/** Error payload returned by an exchange inside a WS response envelope. */
export interface WsError {
  code: number;
  msg: string;
}

/**
 * Parsed WS response to a previously-sent request.
 *
 * Discriminated union: a response carries EITHER `result` OR `error`,
 * never both. `never` on the absent side lets the compiler narrow
 * safely (e.g. `if (resp.error) ...`).
 */
export type WsResponse =
  | { id: string; result: unknown; error?: never }
  | { id: string; result?: never; error: WsError };

/**
 * Per-exchange WebSocket adapter.
 *
 * Responsibilities:
 *   - Hold the credential set bound at construction.
 *   - Know the WS endpoint URL for this exchange's API.
 *   - Build the outbound envelope for a request (with auth/signing).
 *   - Parse inbound messages; return the request/response result or
 *     `null` for push events the DO doesn't care about.
 */
export interface IWsAdapter {
  /** WebSocket endpoint URL (e.g. `wss://ws-api.binance.com:443/ws-api/v3`). */
  readonly url: string;

  /**
   * Build the outbound string to `ws.send(...)` for a logical request.
   *
   * Async because some exchanges (Binance) require per-request HMAC-SHA256
   * signing, and WebCrypto's `crypto.subtle.sign` is promise-based. Adapters
   * that don't need to sign can simply `return Promise.resolve(envelope)`.
   *
   * @param method  Logical method name (e.g. `"order.place"`). The adapter
   *                decides how to translate this into its exchange's envelope.
   * @param params  Method parameters. May be signed inside the adapter
   *                using the credentials bound at construction time.
   * @returns       String ready to be passed to `ws.send()`.
   */
  buildRequest(
    method: string,
    params: Record<string, unknown>
  ): Promise<string>;

  /**
   * Parse an inbound WS message.
   *
   * @returns A `WsResponse` if the message is a response to a
   *          previously-sent request (caller routes by `id`), or `null`
   *          if the message is a push event the DO doesn't track.
   */
  parseResponse(raw: string): WsResponse | null;
}
