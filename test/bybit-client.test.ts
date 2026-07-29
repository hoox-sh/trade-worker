/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
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
import { BybitClient } from "../src/bybit-client.js";

// --- Mocks ---
// Capture the original `fetch` so we can restore it in `afterEach`.
// Without this, the mock leaks to other test files (e.g. yoga-layout's
// WASM loader in TUI tests fails with `TypeError: undefined is not an
// object`).
const originalFetch = global.fetch;
// Simplify mock fetch definition
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
describe("BybitClient (V5)", () => {
  const API_KEY = "test-bybit-key";
  const API_SECRET = "test-bybit-secret";
  const BASE_URL = "https://api.bybit.com";
  const RECV_WINDOW = 5000;

  let client: BybitClient;
  let fixedTimestamp: number;
  let mockSignatureHex: string;

  beforeEach(() => {
    mock.restore();
    // Re-install the fetch mock after mock.restore() removed it
    global.fetch = mockFetch as any;
    mockFetch.mockClear();
    mockImportKey.mockClear();
    mockSign.mockClear();

    fixedTimestamp = Date.now();
    spyOn(Date, "now").mockImplementation(() => fixedTimestamp);

    // Mock crypto functions
    mockImportKey.mockResolvedValue({} as CryptoKey);
    const mockSignatureArrayBuffer = new Uint8Array([
      0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
    ]).buffer;
    mockSign.mockResolvedValue(mockSignatureArrayBuffer);
    mockSignatureHex = "fedcba9876543210";

    // Default fetch mock (successful Bybit V5 response)
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: { data: "mock result" },
          time: Date.now(),
        }),
        { status: 200 }
      )
    );

    client = new BybitClient(API_KEY, API_SECRET);
  });

  afterEach(() => {
    // Restore the real `global.fetch` so subsequent test files aren't
    // polluted with our mock. The beforeEach also calls mock.restore()
    // but that doesn't undo our module-level `global.fetch = mockFetch`.
    global.fetch = originalFetch;
  });

  // --- Constructor Tests ---
  test("should initialize with valid API key and secret", () => {
    expect(client).toBeInstanceOf(BybitClient);
  });

  test("should throw error if API key is missing", () => {
    expect(() => new BybitClient("", API_SECRET)).toThrow(
      "BybitClient API key and secret are required."
    );
  });

  test("should throw error if API secret is missing", () => {
    expect(() => new BybitClient(API_KEY, "")).toThrow(
      "BybitClient API key and secret are required."
    );
  });

  test("should use mainnet base URL by default", () => {
    const c = client as unknown as { baseUrl: string; isTestnet: boolean };
    expect(c.baseUrl).toBe(BASE_URL);
    expect(c.isTestnet).toBe(false);
  });

  test("should use testnet base URL when testnet option is set", () => {
    const testClient = new BybitClient(API_KEY, API_SECRET, { testnet: true });
    const c = testClient as unknown as { baseUrl: string; isTestnet: boolean };
    expect(c.baseUrl).toBe("https://api-testnet.bybit.com");
    expect(c.isTestnet).toBe(true);
  });

  test("supportsTestTrading is true", () => {
    expect(BybitClient.supportsTestTrading).toBe(true);
  });

  // --- Signing Logic Test ---
  test("signRequest should create correct HMAC-SHA256 signature string", async () => {
    const paramsStr = JSON.stringify({
      symbol: "BTCUSDT",
      orderType: "Market",
    });
    const expectedPayload = `${fixedTimestamp}${API_KEY}${RECV_WINDOW}${paramsStr}`;

    const signature = await (client as any).signRequest(
      fixedTimestamp,
      paramsStr
    );

    expect(signature).toBe(mockSignatureHex);
    expect(mockImportKey).toHaveBeenCalledWith(
      "raw",
      expect.any(Uint8Array), // Secret key bytes
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    expect(mockSign).toHaveBeenCalledWith(
      "HMAC",
      {}, // The dummy CryptoKey from mockImportKey
      expect.any(Uint8Array) // Encoded payload bytes
    );

    // Verify the payload bytes passed to sign
    expect(mockSign.mock.calls.length).toBeGreaterThan(0); // Ensure call happened
    const signCallArgs = mockSign.mock.calls[0]; // Get arguments of the first call
    const payloadBuffer = signCallArgs[2] as ArrayBuffer;
    const decodedPayload = new TextDecoder().decode(payloadBuffer);
    expect(decodedPayload).toBe(expectedPayload);
  });

  // --- Request Execution Tests ---
  test("makeRequest (GET) should format URL, generate signature, set headers, and call fetch", async () => {
    const path = "/v5/account/wallet-balance";
    const params = { accountType: "UNIFIED", coin: "USDT" };
    const mockResultData = { list: [{ coin: "USDT", balance: "1000" }] };
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: mockResultData,
          time: Date.now(),
        }),
        { status: 200 }
      )
    );

    // Expected sorted query string for signature and URL
    const expectedQueryString = "accountType=UNIFIED&coin=USDT";
    const expectedSigPayload = `${fixedTimestamp}${API_KEY}${RECV_WINDOW}${expectedQueryString}`;

    const result = await (client as any).makeRequest("GET", path, params);

    expect(result).toEqual(mockResultData);
    expect(mockSign).toHaveBeenCalledTimes(1);
    // Check signature payload was correct
    expect(mockSign.mock.calls.length).toBeGreaterThan(0);
    const signCallArgs = mockSign.mock.calls[0];
    const payloadBuffer = signCallArgs[2] as ArrayBuffer;
    const decodedPayload = new TextDecoder().decode(payloadBuffer);
    expect(decodedPayload).toBe(expectedSigPayload);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    const fetchCallArgs = mockFetch.mock.calls[0];
    const url = fetchCallArgs[0] as string; // URL is the first argument
    const options = fetchCallArgs[1] as RequestInit; // Options is the second

    expect(url).toBe(`${BASE_URL}${path}?${expectedQueryString}`);
    expect(options.method).toBe("GET");
    // Add checks for headers
    expect(options.headers).toBeDefined();
    const headers = options.headers as Record<string, string>; // Assert as Record
    expect(headers["X-BAPI-API-KEY"]).toBe(API_KEY);
    expect(headers["X-BAPI-TIMESTAMP"]).toBe(String(fixedTimestamp));
    expect(headers["X-BAPI-RECV-WINDOW"]).toBe(String(RECV_WINDOW));
    expect(headers["X-BAPI-SIGN"]).toBe(mockSignatureHex);
    expect(options.body).toBeUndefined();
  });

  test("makeRequest (POST) should format body, generate signature, set headers, and call fetch", async () => {
    const path = "/v5/order/create";
    const params = {
      category: "linear",
      symbol: "ETHUSDT",
      side: "Buy",
      orderType: "Market",
      qty: "0.1",
    };
    const mockResultData = { orderId: "12345", orderLinkId: "abc" };
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: mockResultData,
          time: Date.now(),
        }),
        { status: 200 }
      )
    );

    const paramsStr = JSON.stringify(params);
    const expectedSigPayload = `${fixedTimestamp}${API_KEY}${RECV_WINDOW}${paramsStr}`;

    const result = await (client as any).makeRequest("POST", path, params);

    expect(result).toEqual(mockResultData);
    expect(mockSign).toHaveBeenCalledTimes(1);
    // Check signature payload was correct
    expect(mockSign.mock.calls.length).toBeGreaterThan(0);
    const signCallArgs = mockSign.mock.calls[0];
    const payloadBuffer = signCallArgs[2] as ArrayBuffer;
    const decodedPayload = new TextDecoder().decode(payloadBuffer);
    expect(decodedPayload).toBe(expectedSigPayload);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    const fetchCallArgs = mockFetch.mock.calls[0];
    const url = fetchCallArgs[0] as string;
    const options = fetchCallArgs[1] as RequestInit;

    expect(url).toBe(`${BASE_URL}${path}`);
    expect(options.method).toBe("POST");
    expect(options.headers).toBeDefined();
    const headers = options.headers as Record<string, string>; // Assert as Record
    expect(headers["X-BAPI-API-KEY"]).toBe(API_KEY);
    expect(headers["X-BAPI-TIMESTAMP"]).toBe(String(fixedTimestamp));
    expect(headers["X-BAPI-RECV-WINDOW"]).toBe(String(RECV_WINDOW));
    expect(headers["X-BAPI-SIGN"]).toBe(mockSignatureHex);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(options.body).toBe(paramsStr);
  });

  // --- API Method Tests ---

  test("setLeverage should call makeRequest with correct params", async () => {
    const symbol = "BTCUSDT";
    const leverage = 25;
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.setLeverage(symbol, leverage);

    expect(makeRequestSpy).toHaveBeenCalledWith(
      "POST",
      "/v5/position/set-leverage",
      {
        category: "linear",
        symbol: symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      }
    );
  });

  test("executeTrade (Market Long) should call makeRequest with correct params", async () => {
    const params = {
      symbol: "ETHUSDT",
      side: "BUY",
      orderType: "MARKET",
      quantity: 0.5,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.executeTrade(params);

    expect(makeRequestSpy).toHaveBeenCalledWith("POST", "/v5/order/create", {
      category: "linear",
      symbol: params.symbol,
      side: "Buy", // BUY → Buy
      orderType: "Market",
      qty: String(params.quantity),
    });
  });

  test("executeTrade (Limit Close Short) should call makeRequest with correct params", async () => {
    const params = {
      symbol: "ETHUSDT",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 0.5,
      price: 2000,
      reduceOnly: true,
    };
    const makeRequestSpy = spyOn(client as any, "makeRequest");

    await client.executeTrade(params);

    expect(makeRequestSpy).toHaveBeenCalledWith("POST", "/v5/order/create", {
      category: "linear",
      symbol: params.symbol,
      side: "Buy", // BUY → Buy
      orderType: "Limit",
      qty: String(params.quantity),
      price: String(params.price),
      reduceOnly: true,
    });
  });

  test("getAccountInfo should call makeRequest correctly", async () => {
    const makeRequestSpy = spyOn(client as any, "makeRequest");
    await client.getAccountInfo();
    expect(makeRequestSpy).toHaveBeenCalledWith(
      "GET",
      "/v5/account/wallet-balance",
      { accountType: "UNIFIED" }
    );
  });

  test("getPositions should call makeRequest correctly", async () => {
    const makeRequestSpy = spyOn(client as any, "makeRequest");
    await client.getPositions("BTCUSDT");
    expect(makeRequestSpy).toHaveBeenCalledWith("GET", "/v5/position/list", {
      category: "linear",
      symbol: "BTCUSDT",
    });
  });

  // --- Error Handling Tests ---

  test("makeRequest should throw formatted error on non-zero retCode", async () => {
    const errorCode = 10001;
    const errorMsg = "Invalid API Key";
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          retCode: errorCode,
          retMsg: errorMsg,
          result: {},
          time: Date.now(),
        }),
        { status: 200 }
      )
    ); // Status 200

    await expect(
      (client as any).makeRequest("GET", "/v5/account/wallet-balance", {
        accountType: "UNIFIED",
      })
    ).rejects.toThrow(`Bybit API Error (${errorCode}): ${errorMsg}`);
  });

  test("makeRequest should handle non-200 status codes (though Bybit usually uses retCode)", async () => {
    // This test is less likely for Bybit V5 but good practice
    const errorMsg = "Gateway Timeout";
    // Simulate possible body with non-200 status
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          retCode: 50400,
          retMsg: errorMsg,
        }),
        { status: 504 }
      )
    );

    // Expect it to fail based on retCode primarily
    await expect(
      (client as any).makeRequest("GET", "/v5/account/wallet-balance", {
        accountType: "UNIFIED",
      })
    ).rejects.toThrow(`Bybit API Error (50400): ${errorMsg}`);
  });

  test("makeRequest should re-throw fetch network error", async () => {
    const networkError = new Error("Fetch connection failed");
    mockFetch.mockRejectedValueOnce(networkError);

    await expect(
      (client as any).makeRequest("GET", "/v5/account/wallet-balance", {
        accountType: "UNIFIED",
      })
    ).rejects.toThrow(networkError);
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: origCrypto,
    writable: true,
  });
});
