/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebhookPayload } from "@hoox-sh/hoox-shared/types";
import {
  createLogger,
  requireInternalAuth,
  type InternalAuthEnv,
} from "@hoox-sh/hoox-shared/middleware";
import { TRADE_READ_AUTH_KEY_FIELDS } from "@hoox-sh/hoox-shared/service-bindings";
import { toError } from "@hoox-sh/hoox-shared/errors";

const logger = createLogger({ service: "trade-worker", module: "reports" });

/** All trade reports are written under this prefix — reads are restricted to it. */
export const REPORT_KEY_PREFIX = "trade-reports/";
const MAX_REPORT_KEY_LENGTH = 512;

// --- Type Definitions ---

/**
 * Minimal environment interface for report operations.
 * Only includes the bindings needed by saveReportToR2 and handleGetReportRequest.
 */
export interface ReportsEnv {
  REPORTS_BUCKET?: R2Bucket;
  INTERNAL_KEY_BINDING?: string;
}

// --- Helpers ---

/**
 * Sanitize a single path segment for R2 object keys (exchange / symbol / id).
 * Strips path separators, parent-dir markers, and control characters so payload
 * fields cannot escape the trade-reports/ namespace.
 * Accepts non-strings (e.g. numeric log ids from older call sites).
 */
export function sanitizeReportPathSegment(
  segment: string | number | null | undefined
): string {
  const raw = String(segment ?? "");
  const cleaned = raw
    .replace(/\.\./g, "_")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/**
 * Defense-in-depth: only allow GET for keys under trade-reports/, reject
 * path traversal, absolute paths, and unexpected characters.
 */
export function isSafeReportKey(key: string): boolean {
  if (!key || key.length > MAX_REPORT_KEY_LENGTH) return false;
  if (key.includes("\0") || key.includes("\\")) return false;
  if (key.startsWith("/") || key.includes("..")) return false;
  if (!key.startsWith(REPORT_KEY_PREFIX)) return false;
  // Allow nested path segments with safe characters only
  if (!/^[a-zA-Z0-9/_.\-:=]+$/.test(key)) return false;
  return true;
}

// --- Report Functions ---

/**
 * Saves a trade report object to the R2 bucket.
 * Task 3.5 & 3.6
 */
export async function saveReportToR2(
  reportData: unknown, // The trade result or formatted report data
  payload: WebhookPayload,
  dbLogId: string | null, // Changed to string
  env: ReportsEnv
): Promise<void> {
  if (!env.REPORTS_BUCKET) {
    logger.error(
      "REPORTS_BUCKET binding is not configured. Skipping report save.",
      { dbLogId }
    );
    return;
  }

  try {
    // Format a simple report (can be expanded later)
    const reportContent = JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        tradePayload: payload,
        tradeResult: reportData,
        dbLogId: dbLogId,
      },
      null,
      2
    );

    // Generate a unique filename under the locked-down prefix
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const exchangeSeg = sanitizeReportPathSegment(payload.exchange);
    const symbolSeg = sanitizeReportPathSegment(payload.symbol);
    const idSeg = sanitizeReportPathSegment(dbLogId || "no-id");
    const filename = `${REPORT_KEY_PREFIX}${exchangeSeg}/${symbolSeg}/${timestamp}-${idSeg}.json`;

    logger.info("Attempting to save report to R2", { dbLogId, filename });

    // Put the object into the R2 bucket
    const r2Object = await env.REPORTS_BUCKET.put(filename, reportContent, {
      httpMetadata: { contentType: "application/json" },
    });

    logger.info("Successfully saved report to R2", {
      dbLogId,
      etag: r2Object?.etag,
    });
  } catch (error: unknown) {
    const errorMsg = toError(error, "Unknown R2 error");
    logger.error("Failed to save report to R2", { dbLogId, error: errorMsg });
  }
}

/**
 * Handles GET requests to retrieve a specific report from R2.
 * Expects a 'key' query parameter specifying the R2 object key.
 * Task 3.5
 */
export async function handleGetReportRequest(
  request: Request,
  env: ReportsEnv
): Promise<Response> {
  const authError = requireInternalAuth(
    request,
    env as InternalAuthEnv,
    TRADE_READ_AUTH_KEY_FIELDS
  );
  if (authError) {
    return authError;
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!key) {
    return new Response("Missing 'key' query parameter", { status: 400 });
  }

  if (!isSafeReportKey(key)) {
    return new Response(
      "Invalid report key (must be under trade-reports/ with no path traversal)",
      { status: 400 }
    );
  }

  if (!env.REPORTS_BUCKET) {
    logger.error("REPORTS_BUCKET binding is not configured");
    return new Response("R2 service not configured.", { status: 500 });
  }

  try {
    logger.info("Attempting to retrieve R2 object", { key });
    const object = await env.REPORTS_BUCKET.get(key);

    if (object === null) {
      logger.info("R2 object not found", { key });
      return new Response("Report not found", { status: 404 });
    }

    logger.info("Successfully retrieved R2 object", { key, size: object.size });

    // Prepare headers for the response
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    // Stream the body back — object.body is ReadableStream | null;
    // Response constructor accepts ReadableStream | null (null yields empty body)
    return new Response(object.body, {
      headers,
    });
  } catch (error: unknown) {
    const errorMsg = toError(error, "Unknown R2 get error");
    logger.error("Failed to retrieve R2 object", { key, error: errorMsg });
    return new Response(`Failed to retrieve report: ${errorMsg}`, {
      status: 500,
    });
  }
}
