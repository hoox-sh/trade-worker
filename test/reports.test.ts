/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  test,
  expect,
  mock,
  jest,
  beforeEach,
  afterEach,
} from "bun:test";
import { saveReportToR2, handleGetReportRequest } from "../src/reports";
import type { WebhookPayload } from "@jango-blockchained/hoox-shared/types";

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Creates a mock R2 object body with the given text content.
 * Mimics the R2ObjectBody interface from @cloudflare/workers-types.
 */
function createMockR2ObjectBody(bodyText: string, etag: string) {
  const bytes = new TextEncoder().encode(bodyText);
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    httpEtag: etag,
    size: bytes.length,
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", "application/json");
      headers.set("content-length", String(bytes.length));
    },
  };
}

/**
 * Default mock WebhookPayload used across tests.
 */
const defaultPayload: WebhookPayload = {
  exchange: "binance",
  symbol: "BTCUSDT",
  action: "LONG",
  quantity: 0.5,
  price: 65000,
};

// ============================================================================
// saveReportToR2
// ============================================================================

describe("saveReportToR2", () => {
  let mockPut: ReturnType<typeof mock>;
  let mockBucket: { put: typeof mockPut };
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    // Fresh mock for each test
    mockPut = mock(() => ({ etag: "mock-etag-123" }));
    mockBucket = { put: mockPut };

    // Spy on console methods so they don't pollute output and can be asserted
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Test 1: Filename format
  // --------------------------------------------------------------------------
  test("saves report to R2 with correct filename format", async () => {
    const reportData = {
      orderId: "ord-789",
      status: "filled",
      filledPrice: 65100,
    };
    const dbLogId = "db-log-abc-456";

    await saveReportToR2(reportData, defaultPayload, dbLogId, {
      REPORTS_BUCKET: mockBucket as any,
    });

    expect(mockPut).toHaveBeenCalledTimes(1);

    const filename = mockPut.mock.calls[0][0] as string;
    // Format: trade-reports/{exchange}/{symbol}/{timestamp}-{id}.json
    expect(filename).toMatch(
      /^trade-reports\/binance\/BTCUSDT\/.+-db-log-abc-456\.json$/
    );
    // Verify it contains the exchange, symbol, and dbLogId
    expect(filename).toContain("binance");
    expect(filename).toContain("BTCUSDT");
    expect(filename).toContain(dbLogId);
    expect(filename).toEndWith(".json");
  });

  // --------------------------------------------------------------------------
  // Test 2: Report content structure
  // --------------------------------------------------------------------------
  test("includes timestamp, tradePayload, tradeResult, dbLogId in report content", async () => {
    const reportData = { orderId: "ord-789", status: "filled" };
    const dbLogId = "db-log-xyz-789";

    await saveReportToR2(reportData, defaultPayload, dbLogId, {
      REPORTS_BUCKET: mockBucket as any,
    });

    expect(mockPut).toHaveBeenCalledTimes(1);

    const content = JSON.parse(mockPut.mock.calls[0][1] as string);

    // Verify all four fields exist
    expect(content).toHaveProperty("timestamp");
    expect(content).toHaveProperty("tradePayload");
    expect(content).toHaveProperty("tradeResult");
    expect(content).toHaveProperty("dbLogId");

    // Verify types and values
    expect(typeof content.timestamp).toBe("string");
    expect(new Date(content.timestamp).toISOString()).toBe(content.timestamp); // valid ISO
    expect(content.tradePayload).toEqual(defaultPayload);
    expect(content.tradeResult).toEqual(reportData);
    expect(content.dbLogId).toBe(dbLogId);
  });

  // --------------------------------------------------------------------------
  // Test 3: httpMetadata contentType
  // --------------------------------------------------------------------------
  test("sets httpMetadata with contentType application/json", async () => {
    const reportData = { orderId: "ord-789" };
    const dbLogId = "log-001";

    await saveReportToR2(reportData, defaultPayload, dbLogId, {
      REPORTS_BUCKET: mockBucket as any,
    });

    expect(mockPut).toHaveBeenCalledTimes(1);

    // Third argument is the R2PutOptions
    const options = mockPut.mock.calls[0][2] as any;
    expect(options).toBeDefined();
    expect(options.httpMetadata).toBeDefined();
    expect(options.httpMetadata.contentType).toBe("application/json");
  });

  // --------------------------------------------------------------------------
  // Test 4: REPORTS_BUCKET not configured
  // --------------------------------------------------------------------------
  test("returns early when REPORTS_BUCKET is not configured", async () => {
    const reportData = { orderId: "ord-789" };
    const dbLogId = "log-002";

    // Call without REPORTS_BUCKET in env
    await saveReportToR2(reportData, defaultPayload, dbLogId, {} as any);

    // Should NOT call put
    expect(mockPut).not.toHaveBeenCalled();

    // Should log an error explaining the bucket is missing
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("REPORTS_BUCKET binding is not configured")
    );
  });

  // --------------------------------------------------------------------------
  // Test 5: R2 put error handling
  // --------------------------------------------------------------------------
  test("handles R2 put errors gracefully (logs error, does not throw)", async () => {
    const reportData = { orderId: "ord-789" };
    const dbLogId = "log-003";
    const r2Error = new Error("R2 service unavailable");

    // Make put throw
    mockPut = mock(() => {
      throw r2Error;
    });
    mockBucket.put = mockPut;

    // Should NOT throw
    await expect(
      saveReportToR2(reportData, defaultPayload, dbLogId, {
        REPORTS_BUCKET: mockBucket as any,
      })
    ).resolves.toBeUndefined();

    // Should log the error details in JSON format
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save report to R2")
    );
  });

  // --------------------------------------------------------------------------
  // Test 5b: R2 put rejection (async error) also handled
  // --------------------------------------------------------------------------
  test("handles R2 put rejected promise gracefully", async () => {
    const reportData = { orderId: "ord-789" };
    const dbLogId = "log-004";
    const r2Error = new Error("Network timeout");

    mockPut = mock(() => Promise.reject(r2Error));
    mockBucket.put = mockPut;

    await expect(
      saveReportToR2(reportData, defaultPayload, dbLogId, {
        REPORTS_BUCKET: mockBucket as any,
      })
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save report to R2")
    );
  });
});

// ============================================================================
// handleGetReportRequest
// ============================================================================

describe("handleGetReportRequest", () => {
  let mockGet: ReturnType<typeof mock>;
  let mockBucket: { get: typeof mockGet; put?: ReturnType<typeof mock> };
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    mockGet = mock(() => null); // default: object not found
    mockBucket = { get: mockGet };

    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Test 6: Authentication required
  // --------------------------------------------------------------------------
  test("returns 401 when internal auth key is missing", async () => {
    const request = new Request(
      "http://localhost/reports?key=trade-reports/binance/BTCUSDT/report.json"
    );

    const response = await handleGetReportRequest(request, {
      REPORTS_BUCKET: mockBucket as any,
    });

    expect(response.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

  test("returns 401 when internal auth header is wrong", async () => {
    const request = new Request(
      "http://localhost/reports?key=trade-reports/binance/BTCUSDT/report.json",
      { headers: { "X-Internal-Auth-Key": "wrong-key" } }
    );

    const response = await handleGetReportRequest(request, {
      REPORTS_BUCKET: mockBucket as any,
      INTERNAL_KEY_BINDING: "secret-123",
    });

    expect(response.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Test 7: Missing key parameter
  // --------------------------------------------------------------------------
  test("returns 400 when 'key' query parameter is missing", async () => {
    const request = new Request("http://localhost/reports", {
      headers: { "X-Internal-Auth-Key": "secret-123" },
    });

    const response = await handleGetReportRequest(request, {
      REPORTS_BUCKET: mockBucket as any,
      INTERNAL_KEY_BINDING: "secret-123",
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("key");
    // Should not have attempted to call get
    expect(mockGet).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Test 7: REPORTS_BUCKET not configured
  // --------------------------------------------------------------------------
  test("returns 500 when REPORTS_BUCKET is not configured", async () => {
    const request = new Request("http://localhost/reports?key=some-key", {
      headers: { "X-Internal-Auth-Key": "secret-123" },
    });

    const response = await handleGetReportRequest(request, {
      INTERNAL_KEY_BINDING: "secret-123",
    } as any);

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("not configured");
    // Should not have attempted to call get on undefined
    expect(mockGet).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Test 8: Object not found
  // --------------------------------------------------------------------------
  test("returns 404 when object is not found in R2", async () => {
    const request = new Request(
      "http://localhost/reports?key=trade-reports/binance/BTCUSDT/nonexistent.json",
      { headers: { "X-Internal-Auth-Key": "secret-123" } }
    );

    // mockGet already returns null by default
    const response = await handleGetReportRequest(request, {
      REPORTS_BUCKET: mockBucket as any,
      INTERNAL_KEY_BINDING: "secret-123",
    });

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("not found");

    // Verify get was called with the key
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0][0]).toContain("nonexistent.json");
  });

  // --------------------------------------------------------------------------
  // Test 9: Successful retrieval
  // --------------------------------------------------------------------------
  test("returns 200 with object body when found", async () => {
    const reportContent = JSON.stringify({
      timestamp: "2026-05-11T12:00:00.000Z",
      tradePayload: defaultPayload,
      tradeResult: { orderId: "ord-999" },
      dbLogId: "log-success",
    });
    const mockObject = createMockR2ObjectBody(
      reportContent,
      "etag-hello-world"
    );
    mockGet = mock(() => mockObject);
    mockBucket.get = mockGet;

    const request = new Request(
      "http://localhost/reports?key=trade-reports/binance/BTCUSDT/report-123.json",
      { headers: { "X-Internal-Auth-Key": "secret-123" } }
    );

    const response = await handleGetReportRequest(request, {
      REPORTS_BUCKET: mockBucket as any,
      INTERNAL_KEY_BINDING: "secret-123",
    });

    expect(response.status).toBe(200);

    // Verify body content matches
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(JSON.parse(reportContent));
  });

  // --------------------------------------------------------------------------
  // Test 10: ETag header
  // --------------------------------------------------------------------------
  test("sets etag header from httpEtag", async () => {
    const reportContent = JSON.stringify({ status: "ok" });
    const expectedEtag = "etag-unique-value";
    const mockObject = createMockR2ObjectBody(reportContent, expectedEtag);
    mockGet = mock(() => mockObject);
    mockBucket.get = mockGet;

    const request = new Request(
      "http://localhost/reports?key=trade-reports/binance/BTCUSDT/report-etag-test.json",
      { headers: { "X-Internal-Auth-Key": "secret-123" } }
    );

    const response = await handleGetReportRequest(request, {
      REPORTS_BUCKET: mockBucket as any,
      INTERNAL_KEY_BINDING: "secret-123",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(expectedEtag);
    // Also verify the content-type header from writeHttpMetadata is present
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  // --------------------------------------------------------------------------
  // Test 11: R2 get error handling
  // --------------------------------------------------------------------------
  test("handles R2 get errors gracefully (returns 500)", async () => {
    const r2GetError = new Error("R2 internal failure");
    mockGet = mock(() => {
      throw r2GetError;
    });
    mockBucket.get = mockGet;

    const request = new Request(
      "http://localhost/reports?key=trade-reports/binance/BTCUSDT/error-report.json",
      { headers: { "X-Internal-Auth-Key": "secret-123" } }
    );

    const response = await handleGetReportRequest(request, {
      REPORTS_BUCKET: mockBucket as any,
      INTERNAL_KEY_BINDING: "secret-123",
    });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Failed to retrieve report");

    // Verify error was logged (logger outputs JSON, so check message is contained)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to retrieve R2 object")
    );
  });

  // --------------------------------------------------------------------------
  // Test 11b: R2 get rejected promise
  // --------------------------------------------------------------------------
  test("handles R2 get rejected promise gracefully (returns 500)", async () => {
    const r2Error = new Error("Connection reset");
    mockGet = mock(() => Promise.reject(r2Error));
    mockBucket.get = mockGet;

    const request = new Request(
      "http://localhost/reports?key=trade-reports/binance/BTCUSDT/rejected.json",
      { headers: { "X-Internal-Auth-Key": "secret-123" } }
    );

    const response = await handleGetReportRequest(request, {
      REPORTS_BUCKET: mockBucket as any,
      INTERNAL_KEY_BINDING: "secret-123",
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("etag")).toBeNull();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to retrieve R2 object")
    );
  });
});
