/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Entry-level idempotency for trade-worker ingress (/webhook, /process, queue).
 *
 * Best-effort only: CONFIG_KV is not strongly consistent and lacks compare-and-set.
 * Prefer client Idempotency-Key when available; fall back to X-Request-ID or a
 * payload fingerprint. Fail-open on missing KV or KV errors so trading is not
 * halted by infrastructure outages (matches gateway DO fail-open behavior).
 */

const DEFAULT_TTL_SECONDS = 300;
/** Shared namespace for all trade-worker idempotency KV keys. */
const KEY_PREFIX = "idemp:trade:";

export type TradeIdempotencyPayload = {
  exchange: string;
  action: string;
  symbol: string;
  quantity: number;
  test?: boolean;
};

export type IdempotencyCheckResult =
  | { ok: true; key: string; isNew: true }
  | { ok: true; key: string; isNew: false }
  | { ok: false; error: string };

function modeSuffix(test?: boolean): "live" | "test" {
  return test === true ? "test" : "live";
}

/**
 * Resolve an idempotency key for HTTP ingress.
 * Prefer Idempotency-Key header, then X-Request-ID, else payload fingerprint.
 *
 * Client keys: `idemp:client:{key}:{live|test}`
 * Fingerprint: `idemp:fp:{exchange}:{symbol}:{action}:{quantity}:{mode}`
 */
export function resolveTradeIdempotencyKey(
  request: Request,
  payload: TradeIdempotencyPayload
): string {
  const mode = modeSuffix(payload.test);

  const headerKey =
    request.headers.get("Idempotency-Key")?.trim() ||
    request.headers.get("idempotency-key")?.trim();
  if (headerKey) {
    return `idemp:client:${headerKey}:${mode}`;
  }

  const requestId = request.headers.get("X-Request-ID")?.trim();
  if (requestId) {
    return `idemp:client:${requestId}:${mode}`;
  }

  return `idemp:fp:${payload.exchange}:${payload.symbol}:${payload.action}:${payload.quantity}:${mode}`;
}

/**
 * Resolve an idempotency key for queue messages.
 * Prefer `idemp:queue:{requestId}` when requestId is present.
 */
export function resolveQueueIdempotencyKey(trade: {
  requestId?: string;
  exchange: string;
  action: string;
  symbol: string;
  quantity: number;
  test?: boolean;
}): string {
  const requestId = trade.requestId?.trim();
  if (requestId) {
    return `idemp:queue:${requestId}`;
  }
  const mode = modeSuffix(trade.test);
  return `idemp:fp:${trade.exchange}:${trade.symbol}:${trade.action}:${trade.quantity}:${mode}`;
}

/**
 * Check-and-store a key in CONFIG_KV.
 *
 * - Missing KV → `{ isNew: true, skipped: true }` (cannot dedupe; fail-open)
 * - Key present → `{ isNew: false }`
 * - Key absent → put with TTL, `{ isNew: true }`
 * - KV error → `{ isNew: true, skipped: true }` fail-open so trading continues
 */
export async function checkAndStoreIdempotency(
  kv: KVNamespace | undefined,
  key: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<{ isNew: boolean; skipped?: boolean }> {
  if (!kv) {
    return { isNew: true, skipped: true };
  }

  try {
    const existing = await kv.get(key);
    if (existing !== null) {
      return { isNew: false };
    }

    // Clamp TTL: Cloudflare KV requires expirationTtl >= 60
    const ttl = Math.max(60, Math.floor(ttlSeconds));
    await kv.put(key, new Date().toISOString(), { expirationTtl: ttl });
    return { isNew: true };
  } catch {
    // Fail open on KV errors (match gateway DO fail-open) — do not halt trading.
    return { isNew: true, skipped: true };
  }
}

/** @internal exported for tests / diagnostics */
export const _internal = { DEFAULT_TTL_SECONDS, KEY_PREFIX };
