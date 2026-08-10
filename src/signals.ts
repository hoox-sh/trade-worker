/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createLogger,
  requireInternalAuth,
} from "@hoox-sh/hoox-shared/middleware";
import {
  createJsonResponse,
  toError,
} from "@hoox-sh/hoox-shared/errors";
import {
  authenticatedServiceFetch,
  D1_READ_AUTH_KEY_FIELDS,
  D1_WRITE_AUTH_KEY_FIELDS,
  TRADE_EXECUTE_AUTH_KEY_FIELDS,
  TRADE_READ_AUTH_KEY_FIELDS,
  resolveInternalAuthKey,
} from "@hoox-sh/hoox-shared/service-bindings";

const logger = createLogger({ service: "trade-worker", module: "signals" });

// --- Type Definitions ---

/**
 * Minimal environment interface for D1 signal operations.
 * Only includes the bindings needed by these functions.
 */
export interface D1Env {
  D1_SERVICE: Fetcher;
  INTERNAL_KEY_BINDING?: string;
  D1_READ_KEY_BINDING?: string;
  D1_WRITE_KEY_BINDING?: string;
  [key: string]: unknown;
}

// Structure for storing trade signals in D1
export interface TradeSignalRecord {
  signal_id: string;
  timestamp: number;
  symbol: string;
  signal_type: string;
  source?: string;
  raw_data?: string;
}

/**
 * Response shape from d1-worker /query endpoint.
 * Represents both success and error cases.
 */
interface D1ServiceResponse {
  success: boolean;
  error?: string;
  changes?: number;
  lastRowId?: number;
  results?: unknown[];
}

// --- D1 Helper Functions ---

/**
 * Sends a query to d1-worker via service binding and returns the raw response.
 */
async function queryD1(
  env: D1Env,
  query: string,
  params: unknown[] = []
): Promise<D1ServiceResponse> {
  if (!resolveInternalAuthKey(env, D1_READ_AUTH_KEY_FIELDS)) {
    throw new Error("D1 read auth key not configured");
  }

  const response = await authenticatedServiceFetch(
    env.D1_SERVICE,
    env,
    "/query",
    { query, params },
    { internalKeyFields: D1_READ_AUTH_KEY_FIELDS }
  );

  if (!response.ok) {
    throw new Error(`D1_SERVICE responded with ${response.status}`);
  }

  return response.json() as Promise<D1ServiceResponse>;
}

/**
 * Call a named D1 RPC endpoint (fixed SQL templates on d1-worker).
 */
async function rpcD1(
  env: D1Env,
  path: string,
  body: Record<string, unknown>
): Promise<D1ServiceResponse> {
  if (!resolveInternalAuthKey(env, D1_WRITE_AUTH_KEY_FIELDS)) {
    throw new Error("D1 write auth key not configured");
  }

  const response = await authenticatedServiceFetch(
    env.D1_SERVICE,
    env,
    path,
    body,
    { internalKeyFields: D1_WRITE_AUTH_KEY_FIELDS }
  );

  if (!response.ok) {
    throw new Error(`D1_SERVICE ${path} responded with ${response.status}`);
  }

  return response.json() as Promise<D1ServiceResponse>;
}

/**
 * Validate POST /api/signals body fields (types, bounds, safe symbol chars).
 * Returns an error message string, or null when valid.
 */
export function validateSignalPayload(
  payload: Record<string, unknown>
): string | null {
  if (
    payload.symbol === undefined ||
    payload.signal_type === undefined ||
    payload.timestamp === undefined
  ) {
    return "Missing required fields: symbol, signal_type, timestamp";
  }

  if (typeof payload.symbol !== "string") {
    return "Invalid symbol (must be a string)";
  }
  const symbol = payload.symbol.trim();
  if (symbol.length < 1 || symbol.length > 32) {
    return "Invalid symbol (length 1-32)";
  }
  // Exchange-style symbols only — blocks path/injection characters
  if (!/^[A-Za-z0-9_./:-]+$/.test(symbol)) {
    return "Invalid symbol (disallowed characters)";
  }

  if (typeof payload.signal_type !== "string") {
    return "Invalid signal_type (must be a string)";
  }
  const signalType = payload.signal_type.trim();
  if (signalType.length < 1 || signalType.length > 32) {
    return "Invalid signal_type (length 1-32)";
  }

  if (
    typeof payload.timestamp !== "number" ||
    !Number.isFinite(payload.timestamp) ||
    payload.timestamp <= 0
  ) {
    return "Invalid timestamp (must be a positive finite number)";
  }

  if (
    payload.source !== undefined &&
    (typeof payload.source !== "string" || payload.source.length > 128)
  ) {
    return "Invalid source (string, max 128 chars)";
  }

  return null;
}

/**
 * Inserts a trade signal into the D1 database via named RPC.
 */
export async function insertSignal(
  signal: TradeSignalRecord,
  env: D1Env
): Promise<D1ServiceResponse> {
  if (!env.D1_SERVICE) {
    throw new Error("D1_SERVICE binding not configured.");
  }
  return rpcD1(env, "/rpc/insert-signal", {
    signal_id: signal.signal_id,
    timestamp: signal.timestamp,
    symbol: signal.symbol,
    signal_type: signal.signal_type,
    source: signal.source ?? null,
    raw_data: signal.raw_data ?? null,
  });
}

/**
 * Retrieves recent trade signals from the D1 database (read still uses /query).
 */
export async function getRecentSignals(
  env: D1Env,
  limit: number = 10
): Promise<TradeSignalRecord[]> {
  if (!env.D1_SERVICE) {
    throw new Error("D1_SERVICE binding not configured.");
  }
  const query = `SELECT signal_id, timestamp, symbol, signal_type, source, processed_at 
         FROM trade_signals 
         ORDER BY processed_at DESC 
         LIMIT ?`;

  const data = await queryD1(env, query, [limit]);
  if (!data.success) {
    throw new Error(data.error || "D1 getRecentSignals failed");
  }

  return (data.results || []) as TradeSignalRecord[];
}

// --- Request Handlers for D1 ---

/**
 * Handles POST requests to insert a new trade signal into D1.
 */
export async function handlePostSignalRequest(
  request: Request,
  env: D1Env
): Promise<Response> {
  const authResponse = requireInternalAuth(
    request,
    env,
    TRADE_EXECUTE_AUTH_KEY_FIELDS
  );
  if (authResponse) return authResponse;

  let signalPayload: Record<string, unknown>;
  try {
    signalPayload = (await request.json()) as Record<string, unknown>;
  } catch {
    return createJsonResponse(
      { success: false, error: "Invalid JSON payload" },
      400
    );
  }

  // Strict field validation (types + bounds — defense before D1 RPC)
  const validationError = validateSignalPayload(signalPayload);
  if (validationError) {
    return createJsonResponse(
      { success: false, error: validationError },
      400
    );
  }

  const symbol = signalPayload.symbol as string;
  const signalType = signalPayload.signal_type as string;
  const timestamp = signalPayload.timestamp as number;
  const source =
    typeof signalPayload.source === "string"
      ? signalPayload.source.slice(0, 128)
      : undefined;

  // Cap raw payload size stored in D1 to avoid abuse
  let rawData: string | undefined;
  try {
    const serialized = JSON.stringify(signalPayload);
    rawData =
      serialized.length > 8192
        ? serialized.slice(0, 8192) + "…[truncated]"
        : serialized;
  } catch {
    rawData = undefined;
  }

  const signalRecord: TradeSignalRecord = {
    signal_id: crypto.randomUUID(),
    timestamp,
    symbol: symbol.slice(0, 32),
    signal_type: signalType.slice(0, 32),
    source,
    raw_data: rawData,
  };

  try {
    const result = await insertSignal(signalRecord, env);
    if (result.success) {
      logger.info("Successfully inserted signal", {
        signalId: signalRecord.signal_id,
      });
      return createJsonResponse(
        { success: true, result: { signalId: signalRecord.signal_id } },
        201
      ); // 201 Created
    } else {
      logger.error("D1 insert failed", { error: result.error });
      return createJsonResponse(
        { success: false, error: "Failed to store signal in database." },
        500
      );
    }
  } catch (error) {
    logger.error("Error inserting signal into D1", { error: toError(error) });
    return createJsonResponse(
      { success: false, error: "Internal server error while storing signal." },
      500
    );
  }
}

/**
 * Handles GET requests to retrieve recent trade signals from D1.
 */
export async function handleGetSignalsRequest(
  request: Request,
  env: D1Env
): Promise<Response> {
  const authResponse = requireInternalAuth(
    request,
    env,
    TRADE_READ_AUTH_KEY_FIELDS
  );
  if (authResponse) return authResponse;

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? parseInt(limitParam, 10) : 10;

  if (isNaN(limit) || limit <= 0 || limit > 100) {
    // Add reasonable limit bounds
    return createJsonResponse(
      {
        success: false,
        error: "Invalid limit parameter (must be 1-100)",
      },
      400
    );
  }

  try {
    const signals = await getRecentSignals(env, limit);
    return createJsonResponse({ success: true, result: signals }, 200);
  } catch (error) {
    logger.error("Error fetching signals from D1", { error: toError(error) });
    return createJsonResponse(
      {
        success: false,
        error: "Internal server error while fetching signals.",
      },
      500
    );
  }
}

// --- System logs (operator SSE feed via hoox-worker) ---

/**
 * Row shape for system_logs SELECT used by operator log streams.
 */
export interface SystemLogRecord {
  id: string;
  timestamp: number;
  level: string;
  service: string;
  message: string;
  details?: string | null;
}

/**
 * Retrieves recent system_logs rows from D1 (SELECT via d1-worker /query).
 */
export async function getRecentSystemLogs(
  env: D1Env,
  limit: number = 20
): Promise<SystemLogRecord[]> {
  if (!env.D1_SERVICE) {
    throw new Error("D1_SERVICE binding not configured.");
  }
  const query = `SELECT id, timestamp, level, service, message, details
         FROM system_logs
         ORDER BY timestamp DESC
         LIMIT ?`;

  const data = await queryD1(env, query, [limit]);
  if (!data.success) {
    throw new Error(data.error || "D1 getRecentSystemLogs failed");
  }

  return (data.results || []) as SystemLogRecord[];
}

/**
 * Handles GET /api/system-logs — recent system_logs for operator SSE polling.
 * Auth: TRADE_READ_AUTH_KEY_FIELDS (same as GET /api/signals).
 */
export async function handleGetSystemLogsRequest(
  request: Request,
  env: D1Env
): Promise<Response> {
  const authResponse = requireInternalAuth(
    request,
    env,
    TRADE_READ_AUTH_KEY_FIELDS
  );
  if (authResponse) return authResponse;

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? parseInt(limitParam, 10) : 20;

  if (isNaN(limit) || limit <= 0 || limit > 100) {
    return createJsonResponse(
      {
        success: false,
        error: "Invalid limit parameter (must be 1-100)",
      },
      400
    );
  }

  try {
    const logs = await getRecentSystemLogs(env, limit);
    return createJsonResponse({ success: true, result: logs }, 200);
  } catch (error) {
    logger.error("Error fetching system logs from D1", {
      error: toError(error),
    });
    return createJsonResponse(
      {
        success: false,
        error: "Internal server error while fetching system logs.",
      },
      500
    );
  }
}
