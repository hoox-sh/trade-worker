/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  afterAll,
  spyOn,
  mock,
  type Mock,
} from "bun:test";
import { BinanceClient } from "../src/binance-client.js";

// --- Mocks ---
// Capture the original `fetch` so we can restore it in `afterEach`. Without
// this, the mock leaks to other test files (e.g. yoga-layout's WASM loader
// in TUI tests fails with `TypeError: undefined is not an object`).
const originalFetch = global.fetch;
const mockFetch = mock(originalFetch);
global.fetch = mockFetch as any;

const mockImportKey: Mock<typeof crypto.subtle.importKey> = mock(() =>
  Promise.resolve({} as CryptoKey)
);
const mockSign: Mock<typeof crypto.subtle.sign> = mock(() =>
  Promise.resolve(new ArrayBuffer(0))
);

// Preserve original crypto to restore after suite (prevents polluting other tests)
const origCrypto = crypto;

// Mock crypto for Bun's environment — preserves randomUUID to avoid
// breaking other test suites that depend on it
Object.defineProperty(globalThis, "crypto", {
  value: {
    ...origCrypto,
    subtle: {
      importKey: mockImportKey,
      sign: mockSign,
    },
    getRandomValues: mock(<T extends ArrayBufferView | null>(arr: T): T => {
      if (arr instanceof Uint8Array) {
        arr.fill(1);
      }
      return arr;
    }),
  },
  writable: true,
});

// --- Test Suite ---
describe("BinanceClient", () => {
  const API_KEY = "test-binance-key";
  const API_SECRET = "test-binance-secret";
  const BASE_URL = "https://fapi.binance.com";

  let client: BinanceClient;
  let fixedTimestamp: number;
  let mockSignatureHex: string;

  beforeEach(() => {
    mock.restore(); // Keep bun mock restore
    // Re-install the fetch mock after mock.restore() removed it
    global.fetch = mockFetch as any;
    mockFetch.mockClear(); // Add explicit clear
    mockImportKey.mockClear(); // Add explicit clear
    mockSign.mockClear(); // Add explicit clear

    fixedTimestamp = Date.now();
    spyOn(Date, "now").mockImplementation(() => fixedTimestamp);

    // Mock crypto
    mockImportKey.mockResolvedValue({} as CryptoKey);
    const mockSignatureArrayBuffer = new Uint8Array([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    ]).buffer;
    mockSign.mockResolvedValue(mockSignatureArrayBuffer);
    mockSignatureHex = "0123456789abcdef"; // Expected hex signature

    // Default fetch mock using Response object
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true, // Default success for Binance (errors use HTTP status)
          data: "mock data",
        }),
        { status: 200 }
      )
    );

    client = new BinanceClient(API_KEY, API_SECRET);
  });

  afterEach(() => {
    // Restore the real `global.fetch` so subsequent test files aren't
    // polluted with our mock. The beforeEach also calls mock.restore()
    // but that doesn't undo our module-level `global.fetch = mockFetch`.
    global.fetch = originalFetch;
  });

  // --- Constructor Tests ---
  test("should initialize with valid API key and secret", () => {
    expect(client).toBeInstanceOf(BinanceClient);
  });

  test("should throw error if API key is missing", () => {
    expect(() => new BinanceClient("", API_SECRET)).toThrow(
      "BinanceClient API key and secret are required."
    );
  });

  test("should throw error if API secret is missing", () => {
    expect(() => new BinanceClient(API_KEY, "")).toThrow(
      "BinanceClient API key and secret are required."
    );
  });

  test("should use futures mainnet base URL by default", () => {
    const c = client as unknown as { baseUrl: string; isTestnet: boolean };
    expect(c.baseUrl).toBe(BASE_URL);
    expect(c.isTestnet).toBe(false);
  });

  test("should use futures testnet base URL when testnet option is set", () => {
    const testClient = new BinanceClient(API_KEY, API_SECRET, {
      testnet: true,
    });
    const c = testClient as unknown as {
      baseUrl: string;
      isTestnet: boolean;
      testnet: boolean;
    };
    expect(c.baseUrl).toBe("https://testnet.binancefuture.com");
    expect(c.isTestnet).toBe(true);
    expect(c.testnet).toBe(true);
  });

  test("supportsTestTrading is true", () => {
    expect(BinanceClient.supportsTestTrading).toBe(true);
  });

  // --- Signing Logic Test ---
  // (Assuming generateSignature is implicitly tested via makeRequest)

  // --- Request Execution Tests ---
  test("makeRequest should generate signature and call fetch correctly (GET)", async () => {
    const path = "/fapi/v2/account";
    const mockResponseData = { account: "data" };
    // Use mockResolvedValueOnce with new Response
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponseData), { status: 200 })
    );

    const result = await (client as any).makeRequest("GET", path); // Access private method for testing

    expect(result).toEqual(mockResponseData);
    expect(mockImportKey).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const fetchCall = mockFetch.mock.calls[0];
    const url = new URL(fetchCall[0] as string); // Assert as string
    expect(url.origin + url.pathname).toBe(`${BASE_URL}${path}`);
    expect(url.searchParams.has("timestamp")).toBe(true);
    expect(url.searchParams.has("signature")).toBe(true);
    expect(url.searchParams.get("signature")).toBe(mockSignatureHex);

    const options = fetchCall[1] as RequestInit; // Assert as RequestInit
    expect(options.method).toBe("GET");
    expect((options.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe(
      API_KEY
    );
  });

  test("makeRequest should generate signature and call fetch correctly (POST)", async () => {
    const path = "/fapi/v1/leverage";
    const params = { symbol: "BTCUSDT", leverage: 20 };
    const mockResponseData = {
      symbol: "BTCUSDT",
      leverage: 20,
      maxNotionalValue: "1000000",
    };
    // Use mockResolvedValueOnce with new Response
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponseData), { status: 200 })
    );

    const result = await (client as any).makeRequest("POST", path, params);

    expect(result).toEqual(mockResponseData);
    expect(mockImportKey).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const fetchCall = mockFetch.mock.calls[0];
    const url = new URL(fetchCall[0] as string);
    expect(url.origin + url.pathname).toBe(`${BASE_URL}${path}`);
    expect(url.searchParams.get("symbol")).toBe(params.symbol);
    expect(url.searchParams.get("leverage")).toBe(String(params.leverage));
    expect(url.searchParams.has("timestamp")).toBe(true);
    expect(url.searchParams.has("signature")).toBe(true);
    expect(url.searchParams.get("signature")).toBe(mockSignatureHex);

    const options = fetchCall[1] as RequestInit;
    expect(options.method).toBe("POST");
    expect((options.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe(
      API_KEY
    );
    expect(options.body).toBeUndefined(); // Params in query for Binance POST
  });

  // --- API Method Tests ---

  test("setLeverage should call makeRequest with correct params", async () => {
    const symbol = "ETHUSDT";
    const leverage = 10;
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.setLeverage(symbol, leverage);

    expect(makeRequestSpy).toHaveBeenCalledWith("POST", "/fapi/v1/leverage", {
      symbol,
      leverage,
    });
  });

  test("executeTrade (LIMIT BUY) should call makeRequest with correct params", async () => {
    const params = {
      symbol: "BTCUSDT",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 0.01,
      price: 50000,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.executeTrade(params);

    expect(makeRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/fapi/v1/order",
      expect.objectContaining({
        symbol: params.symbol,
        side: "BUY",
        type: "LIMIT",
        quantity: params.quantity,
        price: params.price,
        timeInForce: "GTC", // Added for LIMIT orders
        // reduceOnly: undefined, // Check if client adds this or not
      })
    );
  });

  test("executeTrade (MARKET SELL) should call makeRequest with correct params", async () => {
    const params = {
      symbol: "BTCUSDT",
      side: "SELL",
      orderType: "MARKET",
      quantity: 0.01,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.executeTrade(params);

    expect(makeRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/fapi/v1/order",
      expect.objectContaining({
        symbol: params.symbol,
        side: "SELL",
        type: "MARKET",
        quantity: params.quantity,
        // price: undefined,
        // reduceOnly: undefined,
      })
    );
  });

  test("executeTrade (CLOSE_LONG) should call makeRequest with side=SELL and reduceOnly=true", async () => {
    const params = {
      symbol: "BTCUSDT",
      side: "SELL",
      orderType: "MARKET",
      quantity: 0.01,
      reduceOnly: true,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.executeTrade(params);

    expect(makeRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/fapi/v1/order",
      expect.objectContaining({
        symbol: params.symbol,
        side: "SELL",
        type: "MARKET",
        quantity: params.quantity,
        reduceOnly: true,
      })
    );
  });

  test("executeTrade (CLOSE_SHORT) should call makeRequest with side=BUY and reduceOnly=true", async () => {
    const params = {
      symbol: "BTCUSDT",
      side: "BUY",
      orderType: "MARKET",
      quantity: 0.01,
      reduceOnly: true,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.executeTrade(params);

    expect(makeRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/fapi/v1/order",
      expect.objectContaining({
        symbol: params.symbol,
        side: "BUY",
        type: "MARKET",
        quantity: params.quantity,
        reduceOnly: true,
      })
    );
  });

  test("openLong helper should call executeTrade correctly", async () => {
    const executeTradeSpy = spyOn(client, "executeTrade");
    const symbol = "LINKUSDT";
    const quantity = 10;

    await client.openLong(symbol, quantity);

    expect(executeTradeSpy).toHaveBeenCalledWith({
      symbol,
      side: "BUY",
      quantity,
      price: undefined,
      orderType: "MARKET",
    });
  });

  test("closeShort helper should call executeTrade correctly", async () => {
    const executeTradeSpy = spyOn(client, "executeTrade");
    const symbol = "LINKUSDT";
    const quantity = 10;

    await client.closeShort(symbol, quantity);

    expect(executeTradeSpy).toHaveBeenCalledWith({
      symbol,
      side: "BUY",
      quantity,
      orderType: "MARKET",
      reduceOnly: true,
    });
  });

  test("getAccountInfo should call makeRequest with correct params", async () => {
    const makeRequestSpy = spyOn(client as any, "makeRequest");
    await client.getAccountInfo();
    expect(makeRequestSpy).toHaveBeenCalledWith("GET", "/fapi/v2/account");
  });

  test("getPositions (no symbol) should call makeRequest correctly", async () => {
    const makeRequestSpy = spyOn(client as any, "makeRequest");
    await client.getPositions();
    expect(makeRequestSpy).toHaveBeenCalledWith(
      "GET",
      "/fapi/v2/positionRisk",
      {}
    ); // Empty params object
  });

  test("getPositions (with symbol) should call makeRequest correctly", async () => {
    const symbol = "ADAUSDT";
    const makeRequestSpy = spyOn(client as any, "makeRequest");
    await client.getPositions(symbol);
    expect(makeRequestSpy).toHaveBeenCalledWith(
      "GET",
      "/fapi/v2/positionRisk",
      { symbol }
    );
  });

  // --- Error Handling Tests ---

  test("makeRequest should throw formatted error on non-OK response", async () => {
    const errorResponse = { code: -1001, msg: "Invalid API Key" };
    // Use new Response for error mock
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(errorResponse), { status: 401 })
    );

    await expect(
      (client as any).makeRequest("GET", "/fapi/v2/account")
    ).rejects.toThrow(
      `Binance API Error (${errorResponse.code}): ${errorResponse.msg}`
    );
  });

  test("makeRequest should re-throw fetch error", async () => {
    const networkError = new Error("Fetch failed");
    mockFetch.mockRejectedValueOnce(networkError);

    await expect(
      (client as any).makeRequest("GET", "/fapi/v2/account")
    ).rejects.toThrow(networkError);
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: origCrypto,
    writable: true,
  });
});
