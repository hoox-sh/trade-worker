/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Safe logging helpers for exchange API clients.
 * Never log full URLs (signatures in query), request bodies (signed payloads),
 * or raw response bodies at info level — those can land in Workers Logs
 * when head_sampling_rate is high.
 */

export type ExchangeLogFn = (
  message: string,
  context?: Record<string, unknown>
) => void;

export interface SafeExchangeLogger {
  info: ExchangeLogFn;
  warn?: ExchangeLogFn;
  error?: ExchangeLogFn;
  debug?: ExchangeLogFn;
}

/** Strip query string and hash from a URL; keep origin + path only. */
export function sanitizeExchangeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    // Fallback: drop anything after ? or #
    const q = url.indexOf("?");
    const h = url.indexOf("#");
    let end = url.length;
    if (q >= 0) end = Math.min(end, q);
    if (h >= 0) end = Math.min(end, h);
    return url.slice(0, end);
  }
}

export function logExchangeRequest(
  logger: SafeExchangeLogger,
  exchange: string,
  method: string,
  pathOrUrl: string
): void {
  const path = pathOrUrl.startsWith("http")
    ? sanitizeExchangeUrl(pathOrUrl)
    : pathOrUrl.split("?")[0] ?? pathOrUrl;
  logger.info(`${exchange} request`, { method, path });
}

export function logExchangeResponse(
  logger: SafeExchangeLogger,
  exchange: string,
  status: number,
  opts?: { ok?: boolean; errorCode?: string | number; errorMsg?: string }
): void {
  const payload: Record<string, unknown> = { status };
  if (opts?.errorCode !== undefined) payload.errorCode = opts.errorCode;
  if (opts?.errorMsg !== undefined) {
    // Cap message length — still useful without dumping full payloads
    payload.errorMsg = String(opts.errorMsg).slice(0, 200);
  }
  if (opts?.ok === false || (status >= 400 && opts?.ok !== true)) {
    if (logger.warn) {
      logger.warn(`${exchange} response error`, payload);
    } else {
      logger.info(`${exchange} response error`, payload);
    }
    return;
  }
  logger.info(`${exchange} response`, payload);
}
