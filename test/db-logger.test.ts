/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, beforeEach, jest } from "bun:test";
import { DbLogger, type IDbLogger } from "../src/db-logger";
import type { R2Bucket } from "@cloudflare/workers-types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- Mocks ---
const mockR2Put = jest.fn();

// --- Test Suite ---
// NOTE: This suite does NOT mock crypto.randomUUID to avoid polluting
// global state across other test files. Real UUIDs are generated and
// matched against a UUID regex pattern instead.

describe("DbLogger", () => {
  let mockEnv: { SYSTEM_LOGS_BUCKET?: any };
  let logger: IDbLogger;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock env with R2 bucket enabled
    mockEnv = {
      SYSTEM_LOGS_BUCKET: {
        put: mockR2Put,
      } as any,
    };

    mockR2Put.mockResolvedValue({ etag: "mock-etag" });

    logger = new DbLogger(mockEnv as any);
  });

  // --- Constructor Tests ---
  test("should enable logging if SYSTEM_LOGS_BUCKET binding exists", () => {
    expect((logger as any).enabled).toBe(true);
  });

  test("should disable logging and warn if SYSTEM_LOGS_BUCKET binding is missing", () => {
    const warnSpy = jest.spyOn(console, "warn");
    mockEnv = {}; // No SYSTEM_LOGS_BUCKET
    const disabledLogger = new DbLogger(mockEnv as any);
    expect((disabledLogger as any).enabled).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SYSTEM_LOGS_BUCKET binding not found.")
    );
    warnSpy.mockRestore();
  });

  // --- logRequest Tests ---
  test("logRequest should not call put if logging is disabled", async () => {
    mockEnv = {};
    const disabledLogger = new DbLogger(mockEnv as any);
    const request = new Request("http://test.com/trade", { method: "POST" });

    const result = await disabledLogger.logRequest(request, { data: 1 });

    expect(result).toBeNull();
    expect(mockR2Put).not.toHaveBeenCalled();
  });

  test("logRequest should call SYSTEM_LOGS_BUCKET put with correct data", async () => {
    const requestUrl = "http://test.com/api/trade?action=buy";
    const requestBody = { symbol: "BTCUSDT", quantity: 1 };
    const requestHeaders = {
      "content-type": "application/json",
      "cf-connecting-ip": "1.2.3.4",
      "user-agent": "TestAgent",
    };
    const request = new Request(requestUrl, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
    });

    const result = await logger.logRequest(request, requestBody);

    expect(result).toMatch(UUID_RE);
    expect(mockR2Put).toHaveBeenCalledTimes(1);

    const putCallArgs = mockR2Put.mock.calls[0];
    if (!putCallArgs) throw new Error("expected put call");
    expect(putCallArgs[0]).toContain(`requests/`);
    expect(putCallArgs[0]).toContain(`${result}.json`);

    const payload = JSON.parse(putCallArgs[1] as string);
    expect(payload.type).toBe("request");
    expect(payload.id).toBe(result);
    expect(payload.method).toBe("POST");
    expect(payload.path).toBe("/api/trade");
    expect(payload.body).toEqual(requestBody);
  });

  test("logRequest should return null if R2 put throws an error", async () => {
    const putError = new Error("R2 Error");
    mockR2Put.mockRejectedValueOnce(putError);
    const errorSpy = jest.spyOn(console, "error");
    const request = new Request("http://test.com/trade", { method: "POST" });

    const result = await logger.logRequest(request, {});

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error logging request via R2")
    );
    errorSpy.mockRestore();
  });

  test("logRequest redacts nested sensitive fields before R2 write", async () => {
    const request = new Request("http://test.com/process", {
      method: "POST",
      headers: {
        "x-internal-auth-key": "super-secret-header",
        authorization: "Bearer tok",
      },
    });
    const body = {
      internalAuthKey: "legacy-key",
      payload: {
        apiKey: "nested-api-key",
        apiSecret: "nested-secret",
        exchange: "bybit",
        symbol: "BTCUSDT",
      },
      token: "top-level-token",
    };

    await logger.logRequest(request, body);

    expect(mockR2Put).toHaveBeenCalledTimes(1);
    const firstPut = mockR2Put.mock.calls[0];
    if (!firstPut) throw new Error("expected put call");
    const stored = JSON.parse(firstPut[1] as string);
    expect(stored.headers["x-internal-auth-key"]).toBe("[REDACTED]");
    expect(stored.headers["authorization"]).toBe("[REDACTED]");
    expect(stored.body.internalAuthKey).toBe("[REDACTED]");
    expect(stored.body.token).toBe("[REDACTED]");
    expect(stored.body.payload.apiKey).toBe("[REDACTED]");
    expect(stored.body.payload.apiSecret).toBe("[REDACTED]");
    expect(stored.body.payload.exchange).toBe("bybit");
    expect(stored.body.payload.symbol).toBe("BTCUSDT");
  });

  // --- logResponse Tests ---
  test("logResponse should not call put if logging is disabled", async () => {
    mockEnv = {};
    const disabledLogger = new DbLogger(mockEnv as any);
    const response = new Response("OK", { status: 200 });
    await disabledLogger.logResponse("req-id", response);
    expect(mockR2Put).not.toHaveBeenCalled();
  });

  test("logResponse should not call put if requestId is null", async () => {
    const response = new Response("OK", { status: 200 });
    await logger.logResponse(null, response);
    expect(mockR2Put).not.toHaveBeenCalled();
  });

  test("logResponse should call SYSTEM_LOGS_BUCKET put with correct data", async () => {
    const requestId = crypto.randomUUID();
    const responseStatus = 201;
    const responseBody = JSON.stringify({ message: "Created" });
    const responseHeaders = new Headers({ "x-custom-header": "value" });
    const response = new Response(responseBody, {
      status: responseStatus,
      headers: responseHeaders,
    });
    const startTime = Date.now() - 150; // 150ms execution time
    const error = null;

    await logger.logResponse(requestId, response, error, startTime);

    expect(mockR2Put).toHaveBeenCalledTimes(1);

    const putCallArgs = mockR2Put.mock.calls[0];
    if (!putCallArgs) throw new Error("expected put call");
    expect(putCallArgs[0]).toContain(`responses/`);
    expect(putCallArgs[0]).toContain(`${requestId}.json`);

    const payload = JSON.parse(putCallArgs[1] as string);
    expect(payload.type).toBe("response");
    expect(payload.request_id).toBe(requestId);
    expect(payload.status_code).toBe(responseStatus);
    expect(payload.body).toBe(responseBody);
    expect(payload.error).toBeNull();
  });

  test("logResponse should include error string if provided", async () => {
    const response = new Response("Error", { status: 500 });
    const error = new Error("Something failed");

    await logger.logResponse("req-id", response, error);

    expect(mockR2Put).toHaveBeenCalledTimes(1);
    const putCallArgs = mockR2Put.mock.calls[0];
    if (!putCallArgs) throw new Error("expected put call");
    const payload = JSON.parse(putCallArgs[1] as string);
    expect(payload.error).toBe(error.toString());
  });

  test("logResponse should handle put throwing an error gracefully", async () => {
    const putError = new Error("R2 Error");
    mockR2Put.mockRejectedValueOnce(putError);
    const errorSpy = jest.spyOn(console, "error");
    const response = new Response("OK", { status: 200 });

    // Should not throw
    await expect(
      logger.logResponse("req-id", response)
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error logging response via R2")
    );
    errorSpy.mockRestore();
  });
});
