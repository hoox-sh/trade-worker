/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BaseExchangeClient — shared infrastructure for all exchange API clients.
 *
 * Provides:
 *  - Constructor with apiKey/apiSecret + CryptoKey pre-import
 *  - HMAC-SHA256 signing utility (cryptoSign)
 *  - Shared helper methods (openLong, openShort, closeLong, closeShort)
 *
 * Each exchange subclass must implement:
 *  - getDefaultBaseUrl()
 *  - makeRequest<T>()  — exchange-specific HTTP + signing
 *  - setLeverage(), executeTrade(), getAccountInfo(), getPositions()
 */

import { bufferToHex } from "./exchange-client";

export abstract class BaseExchangeClient {
  protected readonly apiKey: string;
  protected readonly apiSecret: string;
  protected readonly baseUrl: string;
  protected readonly isTestnet: boolean;
  /** Pre-imported CryptoKey for HMAC-SHA256 to avoid importKey overhead on every request. */
  protected readonly importedKeyPromise: Promise<CryptoKey>;

  constructor(
    apiKey: string,
    apiSecret: string,
    baseUrlOrOptions?: string | { baseUrl?: string; testnet?: boolean }
  ) {
    if (!apiKey || !apiSecret) {
      throw new Error(
        `${this.constructor.name} API key and secret are required.`
      );
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    const options =
      typeof baseUrlOrOptions === "string"
        ? { baseUrl: baseUrlOrOptions }
        : (baseUrlOrOptions ?? {});
    this.isTestnet = options.testnet ?? false;
    this.baseUrl = options.baseUrl ?? this.getDefaultBaseUrl();

    const encoder = new TextEncoder();
    this.importedKeyPromise = crypto.subtle.importKey(
      "raw",
      encoder.encode(apiSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
  }

  /** Each subclass provides its exchange-specific base URL. */
  protected abstract getDefaultBaseUrl(): string;

  /**
   * HMAC-SHA256 sign a string using the pre-imported key.
   * Subclasses call this in their signing logic.
   */
  protected async cryptoSign(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const message = encoder.encode(data);
    const importedKey = await this.importedKeyPromise;
    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      importedKey,
      message
    );
    return bufferToHex(signatureBuffer);
  }

  // ── Abstract API methods (exchange-specific) ──

  public abstract setLeverage(
    symbol: string,
    leverage: number
  ): Promise<unknown>;
  public abstract executeTrade(params: {
    symbol: string;
    side: string;
    orderType: string;
    quantity: number;
    price?: number;
    reduceOnly?: boolean;
  }): Promise<unknown>;
  public abstract getAccountInfo(): Promise<unknown>;
  public abstract getPositions(symbol?: string): Promise<unknown>;

  // ── Shared helper methods ──

  async openLong(
    symbol: string,
    quantity: number,
    price?: number,
    orderType = "MARKET"
  ): Promise<unknown> {
    return this.executeTrade({
      symbol,
      side: "BUY",
      quantity,
      price,
      orderType,
    });
  }

  async openShort(
    symbol: string,
    quantity: number,
    price?: number,
    orderType = "MARKET"
  ): Promise<unknown> {
    return this.executeTrade({
      symbol,
      side: "SELL",
      quantity,
      price,
      orderType,
    });
  }

  async closeLong(symbol: string, quantity: number): Promise<unknown> {
    return this.executeTrade({
      symbol,
      side: "SELL",
      quantity,
      orderType: "MARKET",
      reduceOnly: true,
    });
  }

  async closeShort(symbol: string, quantity: number): Promise<unknown> {
    return this.executeTrade({
      symbol,
      side: "BUY",
      quantity,
      orderType: "MARKET",
      reduceOnly: true,
    });
  }
}
