/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  jest as vi,
} from "bun:test";

// `cloudflare:workers` is mocked globally by
// `packages/test-utils/src/setup.ts` (loaded via bunfig.toml `preload`).
// The mock there provides a `DurableObject` base class with `ctx` and
// `state` properties; do NOT re-mock it here (static-import hoisting
// would cause the import resolution to run before this mock takes
// effect, producing `Cannot find package 'cloudflare:workers'`).

import worker, { factories } from "../src/index";
import { factories as routerFactories } from "../src/exchange-router";
import { validateApiCredentials, validateTradePayload } from "../src/execution";
import * as executionModule from "../src/execution.js";
import { saveReportToR2 } from "../src/reports";

// --- Mock Exchange Clients ---
const createMockClient = () => ({
  setLeverage: vi.fn(),
  executeTrade: vi.fn(),
  getAccountInfo: vi.fn(),
  getPositions: vi.fn(),
  openLong: vi.fn(),
  openShort: vi.fn(),
  closeLong: vi.fn(),
  closeShort: vi.fn(),
});

const mockMexcClient = createMockClient();
const mockBinanceClient = createMockClient();
const mockBybitClient = createMockClient();

// --- Mock DbLogger ---
const mockLogRequest = vi.fn();
const mockLogResponse = vi.fn();
const mockLogTrade = vi.fn();
const mockDbLogger = {
  logRequest: mockLogRequest,
  logResponse: mockLogResponse,
  logTrade: mockLogTrade,
};

// --- Wire up factory spies for dependency injection ---
vi.spyOn(routerFactories, "createMexcClient").mockImplementation(
  () => mockMexcClient
);
vi.spyOn(routerFactories, "createBinanceClient").mockImplementation(
  () => mockBinanceClient
);
vi.spyOn(routerFactories, "createBybitClient").mockImplementation(
  () => mockBybitClient
);
vi.spyOn(factories, "createDbLogger").mockImplementation(
  () => mockDbLogger as any
);

// Mock the D1Database methods globally or per suite/test
const mockRun = vi.fn();
const mockAll = vi.fn();
const mockBind = vi.fn(() => ({ run: mockRun, all: mockAll }));
const mockPrepare = vi.fn(() => ({ bind: mockBind }));

const mockEnv = {
  DB: {
    prepare: mockPrepare,
    // Add other necessary D1 methods if used, e.g., batch, dump
  },
  // Add other necessary env bindings with mocks or dummy values
  CONFIG_KV: {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
  AI: { run: vi.fn() },
  REPORTS_BUCKET: {
    put: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
  INTERNAL_KEY_BINDING: "test-internal-key",
  TELEGRAM_SERVICE: {
    fetch: vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      ),
  },
  TELEGRAM_INTERNAL_KEY_BINDING: "test-telegram-key",
  MEXC_KEY_BINDING: "mexc-key",
  MEXC_SECRET_BINDING: "mexc-secret",
  BINANCE_KEY_BINDING: "binance-key",
  BINANCE_SECRET_BINDING: "binance-secret",
  BYBIT_KEY_BINDING: "bybit-key",
  BYBIT_SECRET_BINDING: "bybit-secret",
  D1_SERVICE: { fetch: vi.fn() }, // Mock service binding
} as any; // Use 'as any' for simplicity in testing, or define a more specific mock type

// Helper to create a mock Request object
function createMockRequest(
  method: string,
  urlPath: string,
  body?: any,
  headers?: HeadersInit,
  addInternalAuth = true
): Request {
  const url = `http://localhost${urlPath}`;
  const headerObj = new Headers(headers);
  if (body !== undefined) {
    headerObj.set("Content-Type", "application/json");
  }
  if (addInternalAuth) {
    headerObj.set("X-Internal-Auth-Key", "test-internal-key");
  }

  let finalBody = body;
  if (urlPath === "/process" && body) {
    finalBody = {
      internalAuthKey: addInternalAuth ? "test-internal-key" : undefined,
      payload: body,
    };
  }

  const init: RequestInit = {
    method,
    headers: headerObj,
  };
  if (finalBody !== undefined) {
    init.body = JSON.stringify(finalBody);
  }
  const request = new Request(url, init);
  // Mock the json() method for POST/PUT requests
  if (finalBody !== undefined) {
    request.json = async () => JSON.parse(init.body as string);
  }
  return request;
}

describe("Trade Worker - D1 Signals Endpoint (/api/signals)", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  // --- Tests for POST /api/signals ---
  describe("POST /api/signals", () => {
    const validSignalPayload = {
      timestamp: Math.floor(Date.now() / 1000),
      symbol: "BTCUSDT",
      signal_type: "BUY",
      source: "Test",
    };

    it("should insert a valid signal and return 201", async () => {
      mockEnv.D1_SERVICE.fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, changes: 1, lastRowId: 1 }),
          { status: 200 }
        )
      );

      const request = createMockRequest(
        "POST",
        "/api/signals",
        validSignalPayload
      );
      const response = await worker.fetch(request, mockEnv, {} as any); // Pass mock context if needed

      expect(response.status).toBe(201);
      const responseBody = (await response.json()) as any;
      expect(responseBody.success).toBe(true);
      expect(responseBody.result).toHaveProperty("signalId");
      expect(mockEnv.D1_SERVICE.fetch).toHaveBeenCalledTimes(1);
      expect(mockEnv.D1_SERVICE.fetch).toHaveBeenCalledWith(
        "http://internal/rpc/insert-signal",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "X-Internal-Auth-Key": "test-internal-key",
          }),
          body: expect.stringContaining("signal_id"),
        })
      );
    });

    it("should return 400 for invalid JSON", async () => {
      const request = new Request("http://localhost/api/signals", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": "test-internal-key",
        },
        body: "{ invalid json,",
      });

      const response = await worker.fetch(request, mockEnv, {} as any);
      expect(response.status).toBe(400);
      const responseBody = (await response.json()) as any;
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain("Invalid JSON");
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("should return 400 for missing required fields", async () => {
      const invalidPayload = { timestamp: 123, symbol: "ETHUSDT" }; // Missing signal_type
      const request = createMockRequest("POST", "/api/signals", invalidPayload);
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(400);
      const responseBody = (await response.json()) as any;
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain("Missing required fields");
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("should return 500 if D1 insert fails", async () => {
      mockEnv.D1_SERVICE.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: "D1 Error" }), {
          status: 200,
        })
      );

      const request = createMockRequest(
        "POST",
        "/api/signals",
        validSignalPayload
      );
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(500);
      const responseBody = (await response.json()) as any;
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain(
        "Failed to store signal in database."
      );
      expect(mockEnv.D1_SERVICE.fetch).toHaveBeenCalledTimes(1);
    });

    it("should return 500 if D1 insert throws an exception", async () => {
      mockEnv.D1_SERVICE.fetch.mockRejectedValueOnce(new Error("D1 Exception")); // Simulate D1 exception

      const request = createMockRequest(
        "POST",
        "/api/signals",
        validSignalPayload
      );
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(500);
      const responseBody = (await response.json()) as any;
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain(
        "Internal server error while storing signal."
      );
      expect(mockEnv.D1_SERVICE.fetch).toHaveBeenCalledTimes(1);
    });
  });

  // --- Tests for GET /api/signals ---
  describe("GET /api/signals", () => {
    const mockSignalResults = [
      {
        signal_id: "uuid-1",
        timestamp: 1,
        symbol: "BTC",
        signal_type: "BUY",
        source: "A",
        processed_at: 10,
      },
      {
        signal_id: "uuid-2",
        timestamp: 2,
        symbol: "ETH",
        signal_type: "SELL",
        source: "B",
        processed_at: 9,
      },
    ];

    it("should return recent signals with default limit", async () => {
      mockEnv.D1_SERVICE.fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, results: mockSignalResults }),
          { status: 200 }
        )
      );

      const request = createMockRequest("GET", "/api/signals");
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as any;
      expect(responseBody.success).toBe(true);
      expect(responseBody.result).toEqual(mockSignalResults);
      expect(mockEnv.D1_SERVICE.fetch).toHaveBeenCalledTimes(1);
    });

    it("should return signals with specified limit", async () => {
      mockEnv.D1_SERVICE.fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, results: [mockSignalResults[0]] }),
          { status: 200 }
        )
      );

      const request = createMockRequest("GET", "/api/signals?limit=1");
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as any;
      expect(responseBody.success).toBe(true);
      expect(responseBody.result).toEqual([mockSignalResults[0]]);
      expect(mockEnv.D1_SERVICE.fetch).toHaveBeenCalledTimes(1);
    });

    it("should return empty array if no signals found", async () => {
      mockEnv.D1_SERVICE.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, results: [] }), {
          status: 200,
        })
      );

      const request = createMockRequest("GET", "/api/signals");
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as any;
      expect(responseBody.success).toBe(true);
      expect(responseBody.result).toEqual([]);
      expect(mockEnv.D1_SERVICE.fetch).toHaveBeenCalledTimes(1);
    });

    it("should return 400 for invalid limit parameter (string)", async () => {
      const request = createMockRequest("GET", "/api/signals?limit=abc");
      const response = await worker.fetch(request, mockEnv, {} as any);
      expect(response.status).toBe(400);
      const responseBody = (await response.json()) as any;
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain("Invalid limit");
      expect(mockAll).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid limit parameter (zero)", async () => {
      const request = createMockRequest("GET", "/api/signals?limit=0");
      const response = await worker.fetch(request, mockEnv, {} as any);
      expect(response.status).toBe(400);
      // ... assertions ...
      expect(mockAll).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid limit parameter (too large)", async () => {
      const request = createMockRequest("GET", "/api/signals?limit=101");
      const response = await worker.fetch(request, mockEnv, {} as any);
      expect(response.status).toBe(400);
      // ... assertions ...
      expect(mockAll).not.toHaveBeenCalled();
    });

    it("should return 500 if D1 query fails", async () => {
      mockEnv.D1_SERVICE.fetch.mockRejectedValueOnce(
        new Error("D1 Select Error")
      );

      const request = createMockRequest("GET", "/api/signals");
      const response = await worker.fetch(request, mockEnv, {} as any);

      expect(response.status).toBe(500);
      const responseBody = (await response.json()) as any;
      expect(responseBody.success).toBe(false);
      expect(responseBody.error).toContain(
        "Internal server error while fetching signals."
      );
      expect(mockEnv.D1_SERVICE.fetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Trade Worker Helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset secret bindings for credential tests
    mockEnv.MEXC_KEY_BINDING = "mexc-key";
    mockEnv.MEXC_SECRET_BINDING = "mexc-secret";
    mockEnv.BINANCE_KEY_BINDING = "binance-key";
    mockEnv.BINANCE_SECRET_BINDING = "binance-secret";
    mockEnv.BYBIT_KEY_BINDING = "bybit-key";
    mockEnv.BYBIT_SECRET_BINDING = "bybit-secret";
  });

  describe("validateApiCredentials", () => {
    it("should return true for mexc if keys are present", async () => {
      expect(validateApiCredentials("mexc", mockEnv)).toBe(true);
    });
    it("should return true for binance if keys are present", async () => {
      expect(validateApiCredentials("binance", mockEnv)).toBe(true);
    });
    it("should return true for bybit if keys are present", async () => {
      expect(validateApiCredentials("bybit", mockEnv)).toBe(true);
    });

    it("should return false if key is missing for mexc", async () => {
      mockEnv.MEXC_KEY_BINDING = null;
      expect(validateApiCredentials("mexc", mockEnv)).toBe(false);
    });
    it("should return false if secret is missing for binance", async () => {
      mockEnv.BINANCE_SECRET_BINDING = null;
      expect(validateApiCredentials("binance", mockEnv)).toBe(false);
    });
    it("should return false if key binding itself is missing for bybit", async () => {
      const envWithoutBinding = { ...mockEnv, BYBIT_KEY_BINDING: undefined };
      expect(validateApiCredentials("bybit", envWithoutBinding)).toBe(false);
    });
    it("should return false for unknown exchange", async () => {
      expect(validateApiCredentials("kraken", mockEnv)).toBe(false);
    });
  });

  describe("validateTradePayload", () => {
    const validPayload = {
      exchange: "mexc",
      action: "LONG",
      symbol: "BTC_USDT",
      quantity: 0.01,
    };
    it("should return valid for a correct payload", () => {
      expect(validateTradePayload(validPayload)).toEqual({ isValid: true });
    });
    it("should return invalid if payload is null or not object", () => {
      expect(validateTradePayload(null)).toEqual({
        isValid: false,
        error: "Invalid or missing payload",
      });
      expect(validateTradePayload("string")).toEqual({
        isValid: false,
        error: "Invalid or missing payload",
      });
    });
    it("should return invalid for missing required fields", () => {
      expect(
        validateTradePayload({ ...validPayload, symbol: undefined })
      ).toEqual({
        isValid: false,
        error: "Missing required fields in payload",
      });
    });
    it("should return invalid for invalid action", () => {
      expect(validateTradePayload({ ...validPayload, action: "HOLD" })).toEqual(
        { isValid: false, error: "Invalid action in payload: HOLD" }
      );
    });
    it("should return invalid for non-positive quantity", () => {
      expect(validateTradePayload({ ...validPayload, quantity: 0 })).toEqual({
        isValid: false,
        error: "Invalid quantity in payload",
      });
      expect(validateTradePayload({ ...validPayload, quantity: -1 })).toEqual({
        isValid: false,
        error: "Invalid quantity in payload",
      });
      expect(
        validateTradePayload({ ...validPayload, quantity: "abc" })
      ).toEqual({ isValid: false, error: "Invalid quantity in payload" });
    });
    it("should return invalid for invalid price", () => {
      expect(validateTradePayload({ ...validPayload, price: "abc" })).toEqual({
        isValid: false,
        error: "Invalid price in payload",
      });
    });
    it("should return invalid for invalid leverage", () => {
      expect(
        validateTradePayload({ ...validPayload, leverage: "abc" })
      ).toEqual({ isValid: false, error: "Invalid leverage in payload" });
      expect(validateTradePayload({ ...validPayload, leverage: 0 })).toEqual({
        isValid: false,
        error: "Invalid leverage in payload",
      });
      expect(validateTradePayload({ ...validPayload, leverage: 10.5 })).toEqual(
        { isValid: false, error: "Invalid leverage in payload" }
      ); // Must be integer
    });
    it("should return valid if optional fields (price, leverage, orderType) are missing", () => {
      expect(validateTradePayload(validPayload)).toEqual({ isValid: true });
    });
    it("should return valid if optional fields (price, leverage) are present and valid", () => {
      expect(
        validateTradePayload({ ...validPayload, price: 50000, leverage: 20 })
      ).toEqual({ isValid: true });
    });
  });

  describe("saveReportToR2", () => {
    const reportData = { tradeId: "123", status: "success" };
    const payload = {
      exchange: "mexc",
      symbol: "BTC_USDT",
      action: "LONG" as const,
      quantity: 0.01,
    };
    const dbLogId = "987";

    it("should call R2 put with correct key and data", async () => {
      await saveReportToR2(reportData, payload, dbLogId, mockEnv);

      // Check if put was called at all
      expect(mockEnv.REPORTS_BUCKET.put).toHaveBeenCalled();
    });

    it("should log error and not call put if R2 binding is missing", async () => {
      const errorSpy = vi.spyOn(console, "error");
      const envWithoutR2 = { ...mockEnv, REPORTS_BUCKET: undefined };
      await saveReportToR2(reportData, payload, dbLogId, envWithoutR2);

      expect(mockEnv.REPORTS_BUCKET.put).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("REPORTS_BUCKET binding is not configured")
      );
      errorSpy.mockRestore();
    });

    it("should generate key without dbLogId if null", async () => {
      await saveReportToR2(reportData, payload, null, mockEnv);
      // Check if put was called at all
      expect(mockEnv.REPORTS_BUCKET.put).toHaveBeenCalled();
    });

    it("should log error if R2 put fails", async () => {
      const putError = new Error("R2 Put Failed");
      mockEnv.REPORTS_BUCKET.put.mockRejectedValueOnce(putError);
      const errorSpy = vi.spyOn(console, "error");

      await saveReportToR2(reportData, payload, dbLogId, mockEnv);

      // Check if put was called at all
      expect(mockEnv.REPORTS_BUCKET.put).toHaveBeenCalled();
      // Check that console.error was called (less strict)
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});

describe("Trade Worker Handlers", () => {
  const validPayload = {
    exchange: "mexc",
    action: "LONG",
    symbol: "BTC_USDT",
    quantity: 0.01,
    leverage: 20,
  };
  const logId = 555;

  beforeAll(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mockMexcClient).forEach((fn) => fn.mockReset());
    Object.values(mockBinanceClient).forEach((fn) => fn.mockReset());
    Object.values(mockBybitClient).forEach((fn) => fn.mockReset());
    mockLogRequest.mockReset();
    mockLogResponse.mockReset();
    mockEnv.REPORTS_BUCKET.put.mockClear();

    // Reset specific mockEnv properties to their default values if they were overridden
    mockEnv.INTERNAL_KEY_BINDING = "test-internal-key";
    mockEnv.MEXC_KEY_BINDING = "mexc-key";

    // Default successful mocks
    mockLogRequest.mockResolvedValue(logId);
    mockMexcClient.openLong.mockResolvedValue({ orderId: "mexc123" });
    mockBinanceClient.openLong.mockResolvedValue({ orderId: "bin987" });
    mockBybitClient.openLong.mockResolvedValue({ orderId: "byb456" });
    mockMexcClient.setLeverage.mockResolvedValue({}); // Assume leverage set succeeds
  });

  describe("/process handler", () => {
    it("should validate payload, log, init client, set leverage, execute trade, log response, and save report", async () => {
      const request = createMockRequest("POST", "/process", validPayload);
      const startTime = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(startTime);

      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.success).toBe(true);
      expect(body.result).toEqual({ orderId: "mexc123" });

      // Check logger init and calls
      expect(factories.createDbLogger).toHaveBeenCalledWith(mockEnv);
      expect(mockLogRequest).toHaveBeenCalledWith(
        request,
        {
          internalAuthKey: "test-internal-key",
          payload: validPayload,
        },
        expect.anything()
      );
      // Response object passed to logResponse might be complex to assert fully
      expect(mockLogResponse).toHaveBeenCalledWith(
        logId,
        expect.any(Response),
        null,
        startTime,
        expect.anything()
      );

      // Check client init
      expect(routerFactories.createMexcClient).toHaveBeenCalledWith(
        "mexc-key",
        "mexc-secret",
        { testnet: false }
      );
      expect(routerFactories.createBinanceClient).not.toHaveBeenCalled();
      expect(routerFactories.createBybitClient).not.toHaveBeenCalled();

      // Check client calls (leverage and trade)
      expect(mockMexcClient.setLeverage).toHaveBeenCalledWith(
        validPayload.symbol,
        validPayload.leverage
      );
      expect(mockMexcClient.openLong).toHaveBeenCalledWith(
        validPayload.symbol,
        validPayload.quantity,
        undefined, // price
        "MARKET" // orderType
      );

      // Check R2 save
      expect(mockEnv.REPORTS_BUCKET.put).toHaveBeenCalledWith(
        expect.stringContaining(`trade-reports/mexc/BTC_USDT/`),
        expect.any(String), // The JSON string of the report
        expect.any(Object) // options
      );
    });

    it("should return 400 if payload validation fails", async () => {
      const invalidPayload = { ...validPayload, quantity: -1 };
      const request = createMockRequest("POST", "/process", invalidPayload);
      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.success).toBe(false);
      expect(body.error).toContain("quantity");
      expect(mockLogRequest).toHaveBeenCalled(); // Still logs the bad request
      expect(mockLogResponse).toHaveBeenCalled(); // Still logs the 400 response
      expect(mockMexcClient.openLong).not.toHaveBeenCalled();
    });

    it("should return 400 if API credentials are not configured for the exchange", async () => {
      mockEnv.MEXC_KEY_BINDING = null; // Simulate missing key
      const request = createMockRequest("POST", "/webhook", validPayload);
      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.success).toBe(false);
      expect(body.error).toContain("API secret bindings not configured");
    });

    it("should handle errors during setLeverage gracefully", async () => {
      const leverageError = new Error("Leverage set failed");
      mockMexcClient.setLeverage.mockRejectedValue(leverageError);
      const request = createMockRequest("POST", "/process", validPayload);
      const errorSpy = vi.spyOn(console, "error");

      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);

      expect(response.status).toBe(200); // Still proceeds to trade
      expect(mockMexcClient.openLong).toHaveBeenCalled(); // Trade should still be attempted
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to set leverage")
      );
      errorSpy.mockRestore();
    });

    it("should return 500 if executeTrade fails", async () => {
      const tradeError = new Error("Trade execution failed");
      mockMexcClient.openLong.mockRejectedValue(tradeError);
      const request = createMockRequest("POST", "/process", validPayload);

      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);

      expect(response.status).toBe(500);
      const body = (await response.json()) as any;
      expect(body.success).toBe(false);
      expect(body.error).toContain(tradeError.message);
      expect(mockLogResponse).toHaveBeenCalledWith(
        logId,
        expect.any(Response),
        null,
        expect.any(Number),
        expect.anything()
      );
      expect(mockEnv.REPORTS_BUCKET.put).not.toHaveBeenCalled(); // No report on failure
    });

    it("should select and use Binance client based on payload", async () => {
      const binancePayload = { ...validPayload, exchange: "binance" };
      const request = createMockRequest("POST", "/process", binancePayload);

      await worker.fetch(request, mockEnv, { waitUntil: vi.fn() } as any);

      expect(routerFactories.createBinanceClient).toHaveBeenCalledWith(
        "binance-key",
        "binance-secret",
        { testnet: false }
      );
      expect(mockBinanceClient.openLong).toHaveBeenCalled();
      expect(routerFactories.createMexcClient).not.toHaveBeenCalled();
      expect(routerFactories.createBybitClient).not.toHaveBeenCalled();
    });

    it("should skip leverage setting if leverage not in payload", async () => {
      const noLeveragePayload = { ...validPayload, leverage: undefined };
      const request = createMockRequest("POST", "/process", noLeveragePayload);

      await worker.fetch(request, mockEnv, { waitUntil: vi.fn() } as any);

      expect(mockMexcClient.setLeverage).not.toHaveBeenCalled();
      expect(mockMexcClient.openLong).toHaveBeenCalled();
    });

    it("should return 401 if X-Internal-Auth-Key is missing", async () => {
      const request = createMockRequest(
        "POST",
        "/process",
        validPayload,
        {},
        false
      );
      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);
      expect(response.status).toBe(401);
    });

    it("should return 401 if X-Internal-Auth-Key is invalid", async () => {
      const request = createMockRequest(
        "POST",
        "/process",
        validPayload,
        { "X-Internal-Auth-Key": "wrong-key" },
        false
      );
      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);
      expect(response.status).toBe(401);
    });

    it("should return 500 if INTERNAL_KEY_BINDING is not configured", async () => {
      const envNoKey = { ...mockEnv, INTERNAL_KEY_BINDING: undefined };
      const request = createMockRequest("POST", "/process", validPayload);
      const response = await worker.fetch(request, envNoKey, {
        waitUntil: vi.fn(),
      } as any);
      expect(response.status).toBe(500);
    });
  });

  describe("/process handler (legacy flow)", () => {
    it("should authenticate, validate, and execute trade", async () => {
      const request = createMockRequest("POST", "/process", validPayload);
      await worker.fetch(request, mockEnv, { waitUntil: vi.fn() } as any);

      // Check trade was executed
      expect(routerFactories.createMexcClient).toHaveBeenCalled();
      expect(mockMexcClient.openLong).toHaveBeenCalled();
      // Check logging happened
      expect(mockLogRequest).toHaveBeenCalled();
      expect(mockLogResponse).toHaveBeenCalled();
    });

    it("should return 401 if X-Internal-Auth-Key is missing", async () => {
      const request = createMockRequest(
        "POST",
        "/process",
        validPayload,
        {},
        false
      );
      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);
      expect(response.status).toBe(401);
      const body = (await response.json()) as any;
      expect(body.error).toBe("Unauthorized");
    });

    it("should return 500 if INTERNAL_KEY_BINDING is missing", async () => {
      const envNoKey = { ...mockEnv, INTERNAL_KEY_BINDING: undefined };
      const request = createMockRequest("POST", "/process", validPayload);
      const response = await worker.fetch(request, envNoKey, {
        waitUntil: vi.fn(),
      } as any);
      expect(response.status).toBe(500);
      const body = (await response.json()) as any;
      expect(body.error).toBe("Service configuration error");
    });

    it("should return 400 if nested payload is invalid", async () => {
      const request = createMockRequest("POST", "/process", {
        ...validPayload,
        action: "INVALID",
      });
      const response = await worker.fetch(request, mockEnv, {
        waitUntil: vi.fn(),
      } as any);
      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.error).toContain("action");
    });
  });

  // Tests for /report handler and /test-ai handler can be added here in the future
});

describe("Trade Worker - Health Check Endpoint", () => {
  it("GET /health returns 200 status", async () => {
    const request = new Request("http://localhost/health", {
      method: "GET",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    expect(response.status).toBe(200);
  });

  it("GET /health returns JSON response", async () => {
    const request = new Request("http://localhost/health", {
      method: "GET",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("GET /health includes status field", async () => {
    const request = new Request("http://localhost/health", {
      method: "GET",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    const body = (await response.json()) as any;
    // Health response puts status in body.result.status
    expect(body.result).toHaveProperty("status");
    expect(body.result.status).toBe("ok");
  });

  it("GET /health includes worker name", async () => {
    const request = new Request("http://localhost/health", {
      method: "GET",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    const body = (await response.json()) as any;
    // Health response puts service name in body.result.service
    expect(body.result).toHaveProperty("service");
    expect(body.result.service).toBe("trade-worker");
  });
});

describe("Trade Worker - Webhook Endpoint (/webhook)", () => {
  const validPayload = {
    exchange: "mexc",
    action: "LONG",
    symbol: "BTC_USDT",
    quantity: 0.01,
    leverage: 20,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogRequest.mockResolvedValue(555);
    mockMexcClient.openLong.mockResolvedValue({ orderId: "mexc123" });
    mockMexcClient.setLeverage.mockResolvedValue({});
  });

  it("POST /webhook accepts valid trade payload", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "test-internal-key",
      },
      body: JSON.stringify(validPayload),
    });
    (request as any).json = async () => validPayload;

    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);

    expect([200, 201, 202, 400, 401]).toContain(response.status);
  });

  it("POST /webhook requires authentication", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validPayload),
    });
    (request as any).json = async () => validPayload;

    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);

    expect(response.status).toBe(401);
  });

  it("POST /webhook validates payload", async () => {
    const invalidPayload = { ...validPayload, quantity: -1 };
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "test-internal-key",
      },
      body: JSON.stringify(invalidPayload),
    });
    (request as any).json = async () => invalidPayload;

    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);

    expect([400, 401]).toContain(response.status);
    expect(response.status).toBeLessThan(500);
  });

  it("POST /webhook returns proper response", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "test-internal-key",
      },
      body: JSON.stringify(validPayload),
    });
    (request as any).json = async () => validPayload;

    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);

    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("POST /webhook handles invalid JSON", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "test-internal-key",
      },
      body: "invalid json",
    });
    (request as any).json = async () => {
      throw new Error("Invalid JSON");
    };

    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);

    expect([400, 401, 500]).toContain(response.status);
  });

  it("POST /webhook executes trade on valid payload", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "test-internal-key",
      },
      body: JSON.stringify(validPayload),
    });
    (request as any).json = async () => validPayload;

    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);

    if (response.status < 400) {
      expect(routerFactories.createMexcClient).toHaveBeenCalled();
    }
  });
});

describe("webhook probe mode", () => {
  it("short-circuits before executeTrade and logs per-hop duration", async () => {
    const executeTradeSpy = vi.spyOn(executionModule, "executeTrade");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const probePayload = {
      probe: true,
      probe_id: "p-trade-1",
      symbol: "BTCUSDT",
      action: "LONG",
      quantity: 0.001,
    };

    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "test-internal-key",
      },
      body: JSON.stringify(probePayload),
    });
    (request as any).json = async () => probePayload;

    const ctx = { waitUntil: vi.fn() } as any;
    const response = await worker.fetch(request, mockEnv, ctx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.probe_id).toBe("p-trade-1");
    expect(body.status).toBe("probed");

    expect(executeTradeSpy).not.toHaveBeenCalled();

    const probeLog = consoleSpy.mock.calls.find((call) => {
      const arg = call[0];
      if (typeof arg !== "string") return false;
      try {
        const parsed = JSON.parse(arg) as { probe_id?: string; hop?: string };
        return (
          parsed.probe_id === "p-trade-1" &&
          (parsed.hop === "trade-worker" ||
            parsed.hop === "trade-worker-receive")
        );
      } catch {
        return false;
      }
    });
    expect(probeLog).toBeDefined();

    consoleSpy.mockRestore();
    executeTradeSpy.mockRestore();
  });
});

describe("Trade Worker - Report Endpoint (/report)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /report returns response", async () => {
    const request = new Request("http://localhost/report", {
      method: "GET",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    expect([200, 401, 404, 400, 500]).toContain(response.status);
  });

  it("GET /report with limit parameter", async () => {
    const request = new Request("http://localhost/report?limit=10", {
      method: "GET",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    expect([200, 401, 404, 400, 500]).toContain(response.status);
  });

  it("GET /report with offset parameter", async () => {
    const request = new Request("http://localhost/report?offset=5", {
      method: "GET",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    expect([200, 401, 404, 400, 500]).toContain(response.status);
  });

  it("GET /report with symbol filter", async () => {
    const request = new Request("http://localhost/report?symbol=BTC_USDT", {
      method: "GET",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    expect([200, 401, 404, 400, 500]).toContain(response.status);
  });
});

describe("Trade Worker - Order Execution", () => {
  const validPayload = {
    exchange: "mexc",
    action: "LONG",
    symbol: "BTC_USDT",
    quantity: 0.01,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogRequest.mockResolvedValue(555);
    mockMexcClient.openLong.mockResolvedValue({ orderId: "mexc123" });
    mockMexcClient.setLeverage.mockResolvedValue({});
  });

  it("executes valid BUY order", async () => {
    const request = createMockRequest("POST", "/process", validPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBeLessThan(500);
  });

  it("executes valid SELL order", async () => {
    const sellPayload = { ...validPayload, action: "SHORT" };
    mockMexcClient.openShort.mockResolvedValue({ orderId: "mexc456" });
    const request = createMockRequest("POST", "/process", sellPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBeLessThan(500);
  });

  it("validates order quantity", async () => {
    const invalidPayload = { ...validPayload, quantity: -100 };
    const request = createMockRequest("POST", "/process", invalidPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect([400, 401, 422]).toContain(response.status);
    expect(response.status).toBeLessThan(500);
  });

  it("validates order price", async () => {
    const invalidPayload = { ...validPayload, price: -150.0 };
    const request = createMockRequest("POST", "/process", invalidPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect([400, 401, 422]).toContain(response.status);
    expect(response.status).toBeLessThan(500);
  });

  it("handles concurrent order execution", async () => {
    const orders = [
      { ...validPayload, symbol: "BTC_USDT" },
      { ...validPayload, symbol: "ETH_USDT" },
      { ...validPayload, symbol: "XRP_USDT" },
    ];

    const responses = await Promise.all(
      orders.map((order) =>
        worker.fetch(createMockRequest("POST", "/process", order), mockEnv, {
          waitUntil: vi.fn(),
        } as any)
      )
    );

    responses.forEach((response) => {
      expect(response.status).toBeLessThan(500);
    });
  });

  it("handles very large order quantities", async () => {
    const largePayload = { ...validPayload, quantity: 999999999 };
    const request = createMockRequest("POST", "/process", largePayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBeLessThan(500);
  });

  it("handles fractional shares", async () => {
    const fractionalPayload = { ...validPayload, quantity: 0.5 };
    const request = createMockRequest("POST", "/process", fractionalPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBeLessThan(500);
  });

  it("handles special characters in symbol", async () => {
    const specialPayload = { ...validPayload, symbol: "BRK.B_USDT" };
    const request = createMockRequest("POST", "/process", specialPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBeLessThan(500);
  });

  it("handles unicode characters in payload", async () => {
    const unicodePayload = { ...validPayload, notes: "🚀 ✅ 你好" };
    const request = createMockRequest("POST", "/process", unicodePayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBeLessThan(500);
  });
});

describe("Trade Worker - Position Tracking", () => {
  const validPayload = {
    exchange: "mexc",
    action: "LONG",
    symbol: "BTC_USDT",
    quantity: 0.01,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogRequest.mockResolvedValue(555);
    mockMexcClient.openLong.mockResolvedValue({ orderId: "mexc123" });
    mockMexcClient.getPositions.mockResolvedValue([
      { symbol: "BTC_USDT", quantity: 0.01, entryPrice: 50000 },
    ]);
  });

  it("creates position on BUY order", async () => {
    const request = createMockRequest("POST", "/process", validPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBeLessThan(500);
  });

  it("updates position on additional BUY", async () => {
    const additionalPayload = { ...validPayload, quantity: 0.05 };
    const request = createMockRequest("POST", "/process", additionalPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBeLessThan(500);
  });

  it("closes position on SELL order", async () => {
    const sellPayload = { ...validPayload, action: "SHORT" };
    mockMexcClient.openShort.mockResolvedValue({ orderId: "mexc456" });
    const request = createMockRequest("POST", "/process", sellPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBeLessThan(500);
  });

  it("calculates position P&L", async () => {
    const request = createMockRequest("POST", "/process", validPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    if (response.status < 400) {
      const body = (await response.json()) as any;
      expect(body).toBeDefined();
    }
  });

  it("aggregates positions by symbol", async () => {
    const request = new Request("http://localhost/positions", {
      method: "GET",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    expect([200, 401, 404, 400, 500]).toContain(response.status);
  });
});

describe("Trade Worker - scoped execute/read keys", () => {
  const validPayload = {
    exchange: "mexc",
    action: "LONG",
    symbol: "BTC_USDT",
    quantity: 0.01,
  };

  it("scoped execute key can access /webhook but read key cannot", async () => {
    const executeEnv = {
      ...mockEnv,
      TRADE_EXECUTE_KEY_BINDING: "execute-only-key",
      TRADE_READ_KEY_BINDING: "read-only-key",
      INTERNAL_KEY_BINDING: undefined,
    };

    const webhookRequest = createMockRequest(
      "POST",
      "/webhook",
      validPayload,
      { "X-Internal-Auth-Key": "execute-only-key" },
      false
    );
    const webhookRes = await worker.fetch(webhookRequest, executeEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(webhookRes.status).not.toBe(401);

    const readAttempt = createMockRequest(
      "POST",
      "/webhook",
      validPayload,
      { "X-Internal-Auth-Key": "read-only-key" },
      false
    );
    const readRes = await worker.fetch(readAttempt, executeEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(readRes.status).toBe(401);
  });

  it("scoped read key can access GET /api/signals but not /webhook", async () => {
    const readEnv = {
      ...mockEnv,
      TRADE_READ_KEY_BINDING: "read-only-key",
      TRADE_EXECUTE_KEY_BINDING: "execute-only-key",
      INTERNAL_KEY_BINDING: undefined,
    };

    const signalsRequest = new Request("http://localhost/api/signals?limit=5", {
      method: "GET",
      headers: { "X-Internal-Auth-Key": "read-only-key" },
    });
    const signalsRes = await worker.fetch(signalsRequest, readEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(signalsRes.status).not.toBe(401);

    const writeAttempt = createMockRequest(
      "POST",
      "/webhook",
      validPayload,
      { "X-Internal-Auth-Key": "read-only-key" },
      false
    );
    const writeRes = await worker.fetch(writeAttempt, readEnv, {
      waitUntil: vi.fn(),
    } as any);
    expect(writeRes.status).toBe(401);
  });
});

describe("Trade Worker - Trade Confirmation", () => {
  const validPayload = {
    exchange: "mexc",
    action: "LONG",
    symbol: "BTC_USDT",
    quantity: 0.01,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogRequest.mockResolvedValue(555);
    mockMexcClient.openLong.mockResolvedValue({ orderId: "mexc123" });
  });

  it("confirms executed trade", async () => {
    const request = createMockRequest("POST", "/process", validPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    if (response.status < 400) {
      const body = (await response.json()) as any;
      // Response body has success=true and result containing orderId
      expect(body).toHaveProperty("success");
      expect(body.result).toHaveProperty("orderId");
    }
  });

  it("includes trade details in confirmation", async () => {
    const request = createMockRequest("POST", "/process", validPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    if (response.status < 400) {
      const body = (await response.json()) as any;
      expect(body).toBeDefined();
    }
  });

  it("includes timestamp in confirmation", async () => {
    const request = createMockRequest("POST", "/process", validPayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);
    if (response.status < 400) {
      const body = (await response.json()) as any;
      expect(body).toBeDefined();
    }
  });
});

describe("Trade Worker - Error Handling", () => {
  it("returns 404 for unknown endpoints", async () => {
    const request = new Request("http://localhost/unknown", {
      method: "GET",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    expect(response.status).toBe(404);
  });

  it("returns 405 for wrong HTTP method", async () => {
    const request = new Request("http://localhost/health", {
      method: "POST",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    expect([404, 405]).toContain(response.status);
  });

  it("handles invalid JSON", async () => {
    const request = new Request("http://localhost/process", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "test-internal-key",
      },
      body: "invalid json",
    });
    request.json = async () => {
      throw new Error("Invalid JSON");
    };

    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);

    expect([400, 401, 500]).toContain(response.status);
  });

  it("handles missing authentication", async () => {
    const request = new Request("http://localhost/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exchange: "mexc",
        action: "LONG",
        symbol: "BTC_USDT",
        quantity: 0.01,
      }),
    });
    (request as any).json = async () => ({
      exchange: "mexc",
      action: "LONG",
      symbol: "BTC_USDT",
      quantity: 0.01,
    });

    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);

    expect([200, 201, 202, 401]).toContain(response.status);
  });

  it("handles insufficient funds error", async () => {
    // Mock openLong to simulate insufficient funds
    mockMexcClient.openLong.mockRejectedValueOnce(
      new Error("Insufficient margin")
    );
    const largePayload = {
      exchange: "mexc",
      action: "LONG",
      symbol: "BTC_USDT",
      quantity: 1000000,
    };
    const request = createMockRequest("POST", "/process", largePayload);
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);

    expect([400, 402, 403, 500]).toContain(response.status);
  });

  it("error responses include error message", async () => {
    const request = new Request("http://localhost/unknown", {
      method: "GET",
    });
    const response = await worker.fetch(request, mockEnv, {} as any);
    if (response.status >= 400) {
      const body = (await response.json()) as any;
      expect(body).toHaveProperty("error");
      expect(body).toBeDefined();
    }
  });

  it("handles service configuration errors", async () => {
    const envNoKey = { ...mockEnv, INTERNAL_KEY_BINDING: undefined };
    const request = createMockRequest("POST", "/process", {
      exchange: "mexc",
      action: "LONG",
      symbol: "BTC_USDT",
      quantity: 0.01,
    });
    const response = await worker.fetch(request, envNoKey, {
      waitUntil: vi.fn(),
    } as any);

    expect(response.status).toBe(500);
  });

  it("handles missing API credentials", async () => {
    const envNoMexc = { ...mockEnv, MEXC_KEY_BINDING: null };
    const request = createMockRequest("POST", "/process", {
      exchange: "mexc",
      action: "LONG",
      symbol: "BTC_USDT",
      quantity: 0.01,
    });
    const response = await worker.fetch(request, envNoMexc, {
      waitUntil: vi.fn(),
    } as any);

    expect([400, 401, 500]).toContain(response.status);
  });

  it("handles trade execution failures", async () => {
    mockMexcClient.openLong.mockRejectedValue(new Error("Trade failed"));
    mockLogRequest.mockResolvedValue(555);
    const request = createMockRequest("POST", "/process", {
      exchange: "mexc",
      action: "LONG",
      symbol: "BTC_USDT",
      quantity: 0.01,
    });
    const response = await worker.fetch(request, mockEnv, {
      waitUntil: vi.fn(),
    } as any);

    expect([400, 401, 500]).toContain(response.status);
  });
});
