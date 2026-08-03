/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/src/db-logger.ts

// Database Schema Reference:
// See scripts/init-db.sql for the complete DDL
//
// CREATE TABLE trade_requests (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
//     method TEXT NOT NULL,
//     path TEXT NOT NULL,
//     headers TEXT,
//     body TEXT,
//     source_ip TEXT,
//     user_agent TEXT
// );
//
// CREATE TABLE trade_responses (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     request_id INTEGER,
//     timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
//     status_code INTEGER,
//     headers TEXT,
//     body TEXT,
//     error TEXT,
//     execution_time_ms INTEGER,
//     FOREIGN KEY (request_id) REFERENCES trade_requests(id)
// );

// Define Env structure expected by the logger
// This should align with the Env interface in index.ts

import { createLogger } from "@hoox-sh/hoox-shared/middleware";

interface LoggerEnv {
  D1_SERVICE?: Fetcher;
  SYSTEM_LOGS_BUCKET?: R2Bucket;
}

// Interface defining the DbLogger's capabilities (optional but good practice)
export interface IDbLogger {
  logRequest(
    request: Request,
    requestBody: unknown,
    ctx?: ExecutionContext
  ): Promise<string | null>;
  logResponse(
    requestId: string | null,
    response: Response,
    error?: Error | null,
    startTime?: number,
    ctx?: ExecutionContext
  ): Promise<void>;
}

/**
 * Database logging utility for trade worker using R2.
 */
const logger = createLogger({ service: "trade-worker", module: "db-logger" });

export class DbLogger implements IDbLogger {
  private env: LoggerEnv;
  private enabled: boolean;

  constructor(env: LoggerEnv) {
    this.env = env;
    this.enabled = !!env.SYSTEM_LOGS_BUCKET;
    if (!this.enabled) {
      logger.warn(
        "SYSTEM_LOGS_BUCKET binding not found. Verbose request logging disabled."
      );
    }
  }

  private static headersToObject(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  /**
   * Logs request details to R2.
   * @param request The incoming Request object.
   * @param requestBody The parsed body of the request (can be any type).
   * @param ctx Optional ExecutionContext for non-blocking R2 puts.
   * @returns The ID of the inserted request log record, or null if disabled/failed.
   */
  async logRequest(
    request: Request,
    requestBody: unknown,
    ctx?: ExecutionContext
  ): Promise<string | null> {
    if (!this.enabled || !this.env.SYSTEM_LOGS_BUCKET) return null;

    try {
      const headers = DbLogger.headersToObject(request.headers);
      const redactedHeaders = { ...headers };
      const sensitiveHeaders = [
        "authorization",
        "x-internal-auth-key",
        "cookie",
      ];
      for (const h of sensitiveHeaders) {
        if (redactedHeaders[h]) redactedHeaders[h] = "[REDACTED]";
      }

      let redactedBody: unknown = requestBody;
      if (typeof requestBody === "object" && requestBody !== null) {
        const bodyRecord = { ...(requestBody as Record<string, unknown>) };
        const sensitiveFields = [
          "internalAuthKey",
          "apiKey",
          "password",
          "secret",
          "token",
        ];
        for (const field of sensitiveFields) {
          if (field in bodyRecord) {
            bodyRecord[field] = "[REDACTED]";
          }
        }
        redactedBody = bodyRecord;
      }

      const logId = crypto.randomUUID();
      const logPayload = {
        type: "request",
        id: logId,
        timestamp: new Date().toISOString(),
        method: request.method,
        path: new URL(request.url).pathname,
        headers: redactedHeaders,
        body: redactedBody,
        source_ip: request.headers.get("cf-connecting-ip") || "unknown",
        user_agent: request.headers.get("user-agent") || "unknown",
      };

      const dateStr = new Date().toISOString().split("T")[0];
      const filename = `requests/${dateStr}/${logId}.json`;

      const putPromise = this.env.SYSTEM_LOGS_BUCKET.put(
        filename,
        JSON.stringify(logPayload, null, 2),
        {
          httpMetadata: { contentType: "application/json" },
        }
      );

      if (ctx) {
        // Non-blocking: response returns immediately
        ctx.waitUntil(
          putPromise.catch((err) =>
            console.error("R2 put failed", {
              key: filename,
              error: String(err),
            })
          )
        );
      } else {
        // Backward compatible: await the put
        await putPromise;
      }

      return logId;
    } catch (error: unknown) {
      logger.error("Error logging request via R2", { error });
      return null;
    }
  }

  /**
   * Logs response details to R2.
   * @param requestId The ID of the corresponding request log record.
   * @param response The Response object sent back to the client.
   * @param error Optional error object if the request failed.
   * @param startTime Optional start timestamp (ms) to calculate execution time.
   * @param ctx Optional ExecutionContext for non-blocking R2 puts.
   */
  async logResponse(
    requestId: string | null,
    response: Response,
    error: Error | null = null,
    startTime?: number,
    ctx?: ExecutionContext
  ): Promise<void> {
    if (!this.enabled || !this.env.SYSTEM_LOGS_BUCKET || requestId === null)
      return;

    try {
      const executionTime = startTime ? Date.now() - startTime : null;
      const headersObject: Record<string, string> = {};
      if (response.headers) {
        try {
          response.headers.forEach((value, key) => {
            headersObject[key] = value;
          });
          const sensitiveHeaders = [
            "authorization",
            "x-internal-auth-key",
            "cookie",
          ];
          for (const h of sensitiveHeaders) {
            if (headersObject[h]) headersObject[h] = "[REDACTED]";
          }
        } catch (e) {
          logger.error("Failed to get headers", { error: e });
        }
      } else {
        logger.warn("response.headers is missing for logResponse");
      }

      const responseBody = response.body ? await response.clone().text() : null;
      const errorString = error ? error.toString() : null;

      const logPayload = {
        type: "response",
        request_id: requestId,
        timestamp: new Date().toISOString(),
        status_code: response.status,
        headers: headersObject,
        body: responseBody,
        error: errorString,
        execution_time_ms: executionTime,
      };

      const dateStr = new Date().toISOString().split("T")[0];
      const filename = `responses/${dateStr}/${requestId}.json`;

      const putPromise = this.env.SYSTEM_LOGS_BUCKET.put(
        filename,
        JSON.stringify(logPayload, null, 2),
        {
          httpMetadata: { contentType: "application/json" },
        }
      );

      if (ctx) {
        // Non-blocking: response returns immediately
        ctx.waitUntil(
          putPromise.catch((err) =>
            console.error("R2 put failed", {
              key: filename,
              error: String(err),
            })
          )
        );
        logger.info("Logged response for request ID", { requestId });
      } else {
        // Backward compatible: await the put
        await putPromise;
        logger.info("Logged response for request ID", { requestId });
      }
    } catch (error: unknown) {
      logger.error("Error logging response via R2", { error });
    }
  }
}
