/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/src/mexc-client.ts

import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import type { Logger } from "@jango-blockchained/hoox-shared/middleware";
import {
  BaseExchangeClient,
  type ExchangeClientOptions,
  type OrderResponse,
  type Position,
} from "@jango-blockchained/hoox-shared/exchanges";

// Define interfaces for MEXC API responses (adjust based on actual API)
interface MexcSuccessResponse<T> {
  code: number; // Typically 200 for success
  data: T;
  msg?: string;
}

interface MexcErrorResponse {
  code: number;
  msg: string;
  data?: unknown;
}

type MexcApiResponse<T> = MexcSuccessResponse<T> | MexcErrorResponse;

/** MEXC contract (futures) V1 mainnet host. */
export const MEXC_CONTRACT_BASE_URL =
  "https://contract.mexc.com/api/v1/contract";

/**
 * MEXC API client implementation.
 *
 * Note: MEXC does not offer a public API sandbox/testnet for automated
 * trading (only a UI-only futures demo). Requests with `test: true` are
 * rejected by the exchange router before this client is constructed.
 */
export class MexcClient extends BaseExchangeClient {
  /** MEXC has no public REST testnet for trading. */
  static readonly supportsTestTrading = false;

  private readonly logger: Logger;

  constructor(
    apiKey: string,
    apiSecret: string,
    options?: ExchangeClientOptions
  ) {
    if (options?.testnet) {
      throw new Error(
        "TEST_TRADING_UNSUPPORTED: mexc does not support test/sandbox trading via API"
      );
    }
    super(apiKey, apiSecret, options);
    this.logger = createLogger({
      service: "trade-worker",
      module: "mexc-client",
    });
  }

  protected getErrorMessagePrefix(): string {
    return "MexcClient ";
  }

  protected getDefaultBaseUrl(): string {
    return MEXC_CONTRACT_BASE_URL;
  }

  /**
   * Generates HMAC-SHA256 signature for authenticated requests.
   * MEXC expects sorted query params + timestamp in the signature payload.
   * Renamed from `generateSignature` to avoid clashing with the base
   * class method of the same name (which has a different signature).
   */
  private async signRequest(
    params: Record<string, string | number>,
    timestamp: number
  ): Promise<string> {
    // Convert all values to string for consistency
    const stringParams: Record<string, string> = {};
    for (const key in params) {
      stringParams[key] = String(params[key]);
    }

    const queryString = Object.keys(stringParams)
      .sort()
      .map((key) => `${key}=${stringParams[key]}`)
      .join("&");

    // Signature payload includes timestamp
    const signaturePayload = `${queryString}&timestamp=${timestamp}`;
    return this.cryptoSign(signaturePayload);
  }

  /**
   * Makes an authenticated request to the MEXC API.
   */
  private async makeRequest<T>(
    method: string,
    path: string,
    params: Record<string, string | number> = {}
  ): Promise<T> {
    const timestamp = Date.now();
    const signature = await this.signRequest(params, timestamp);

    const allParams = { ...params, timestamp, signature };

    const url = new URL(`${this.baseUrl}${path}`);

    const options: RequestInit = {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "X-MEXC-APIKEY": this.apiKey,
      },
    };

    if (method === "GET" || method === "DELETE") {
      // Append params to URL for GET/DELETE
      Object.entries(allParams).forEach(([key, value]) =>
        url.searchParams.append(key, String(value))
      );
    } else if (method === "POST" || method === "PUT") {
      // Send params in body for POST/PUT
      options.body = JSON.stringify(allParams);
    }

    this.logger.info("MEXC Request", { method, url: url.toString() });
    if (options.body) {
      this.logger.info("MEXC Request Body", { body: options.body });
    }

    const response = await fetch(url.toString(), options);
    const responseData: MexcApiResponse<T> = await response.json();

    this.logger.info("MEXC Response Status", { status: response.status });
    this.logger.info("MEXC Response Body", {
      body: JSON.stringify(responseData),
    });

    if (!response.ok || responseData.code !== 200) {
      throw new Error(
        `MEXC API Error (${responseData.code}): ${responseData.msg || "Unknown error"}`
      );
    }

    return (responseData as MexcSuccessResponse<T>).data;
  }

  /**
   * Set leverage for a symbol.
   * MEXC V1 Futures API endpoint: POST /api/v1/private/position/change_leverage
   */
  async setLeverage(
    symbol: string,
    leverage: number,
    _positionSide: string = "BOTH"
  ): Promise<void> {
    const path = "/private/position/change_leverage";
    const params: Record<string, string | number> = {
      symbol: symbol,
      leverage: leverage,
    };
    await this.makeRequest<unknown>("POST", path, params);
  }

  /**
   * Execute a trade order.
   */
  async executeTrade(params: {
    symbol: string;
    side: string;
    orderType: string;
    quantity: number;
    price?: number;
    reduceOnly?: boolean;
  }): Promise<OrderResponse> {
    const path = "/private/order/submit";
    const apiParams: Record<string, string | number> = {
      symbol: params.symbol,
      side: 1, // Default to Open Long, will be overridden below if needed
      type: params.orderType?.toUpperCase() === "LIMIT" ? 1 : 2, // 1: Limit, 2: Market
      openType: 1, // 1: Isolated, 2: Cross
      volume: params.quantity, // Quantity
    };

    // Map exchange-agnostic side names ("BUY"/"SELL") to MEXC V1 futures side values.
    // BaseExchangeClient helpers send:
    //   openLong   → side: "BUY"                         → 1 = Open Long
    //   openShort  → side: "SELL"                        → 2 = Open Short
    //   closeLong  → side: "SELL", reduceOnly: true      → 3 = Close Long
    //   closeShort → side: "BUY",  reduceOnly: true      → 4 = Close Short
    if (params.reduceOnly) {
      apiParams.side = params.side.toUpperCase() === "SELL" ? 3 : 4;
    } else {
      apiParams.side = params.side.toUpperCase() === "SELL" ? 2 : 1;
    }

    if (apiParams.type === 1 && params.price) {
      // Only add price for LIMIT orders
      apiParams.price = params.price;
    }

    return this.makeRequest<OrderResponse>("POST", path, apiParams);
  }

  // --- Account Info ---

  async getAccountInfo(): Promise<Record<string, unknown>> {
    const path = "/private/account/assets";
    return this.makeRequest<Record<string, unknown>>("GET", path);
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const path = "/private/position/list";
    const params: Record<string, string> = {};
    if (symbol) {
      params.symbol = symbol;
    }
    return this.makeRequest<Position[]>("GET", path, params);
  }
}
