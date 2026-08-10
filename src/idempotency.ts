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
 * Prefer gateway-resolved `idempotencyKey` when present (aligns with DO),
 * then `idemp:queue:{requestId}`, else payload fingerprint.
 */
export function resolveQueueIdempotencyKey(trade: {
  requestId?: string;
  /** Gateway-resolved key (client or auto fingerprint) from TradeQueueMessage. */
  idempotencyKey?: string;
  exchange: string;
  action: string;
  symbol: string;
  quantity: number;
  test?: boolean;
}): string {
  const gatewayKey = trade.idempotencyKey?.trim();
  if (gatewayKey) {
    return gatewayKey;
  }
  const requestId = trade.requestId?.trim();
  if (requestId) {
    return `idemp:queue:${requestId}`;
  }
  const mode = modeSuffix(trade.test);
  return `idemp:fp:${trade.exchange}:${trade.symbol}:${trade.action}:${trade.quantity}:${mode}`;
}

/**
 * Get-only check: whether an idempotency key is already present in CONFIG_KV.
 * Used by the queue path so a failed execute can still retry within TTL.
 *
 * - Missing KV → `{ present: false, skipped: true }` (cannot dedupe; fail-open)
 * - Key present → `{ present: true }`
 * - Key absent → `{ present: false }`
 * - KV error → `{ present: false, skipped: true }` fail-open so trading continues
 */
export async function isIdempotencyKeyPresent(
  kv: KVNamespace | undefined,
  key: string
): Promise<{ present: boolean; skipped?: boolean }> {
  if (!kv) {
    return { present: false, skipped: true };
  }

  try {
    const existing = await kv.get(key);
    return { present: existing !== null };
  } catch {
    // Fail open on KV errors (match gateway DO fail-open) — do not halt trading.
    return { present: false, skipped: true };
  }
}

/**
 * Put-only store of an idempotency key after a successful execute (queue path).
 *
 * - Missing KV → `{ stored: false, skipped: true }`
 * - Put succeeds → `{ stored: true }`
 * - KV error → `{ stored: false, skipped: true }` fail-open
 */
export async function storeIdempotencyKey(
  kv: KVNamespace | undefined,
  key: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<{ stored: boolean; skipped?: boolean }> {
  if (!kv) {
    return { stored: false, skipped: true };
  }

  try {
    // Clamp TTL: Cloudflare KV requires expirationTtl >= 60
    const ttl = Math.max(60, Math.floor(ttlSeconds));
    await kv.put(key, new Date().toISOString(), { expirationTtl: ttl });
    return { stored: true };
  } catch {
    return { stored: false, skipped: true };
  }
}

/**
 * Check-and-store a key in CONFIG_KV (HTTP ingress path).
 *
 * Unchanged semantics for /webhook and /process: check+store **before** execute
 * so concurrent HTTP retries are best-effort deduped. Queue consumers use
 * `isIdempotencyKeyPresent` + `storeIdempotencyKey` instead (store only after success).
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
  const check = await isIdempotencyKeyPresent(kv, key);
  if (check.skipped) {
    return { isNew: true, skipped: true };
  }
  if (check.present) {
    return { isNew: false };
  }

  const store = await storeIdempotencyKey(kv, key, ttlSeconds);
  if (store.skipped) {
    return { isNew: true, skipped: true };
  }
  return { isNew: true };
}

/** @internal exported for tests / diagnostics */
export const _internal = { DEFAULT_TTL_SECONDS, KEY_PREFIX };
