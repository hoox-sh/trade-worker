/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { DurableObject } from "cloudflare:workers";
import {
  createLogger,
  safeWaitUntil,
} from "@hoox-sh/hoox-shared/middleware";
import type { Env } from "./index";
import { BinanceClient } from "./binance-client";
import { BybitClient } from "./bybit-client";
import { MexcClient } from "./mexc-client";
import type { WebhookPayload } from "@hoox-sh/hoox-shared/types";
import type { TradeExecutionResult } from "./execution";
import { resolveExchangeCredentials } from "./exchange-credentials";
import { getAdapter } from "./wsAdapters/adapters";
import type { IWsAdapter } from "./wsAdapters/types";

const logger = createLogger({
  service: "trade-worker",
  module: "exchange-connection-manager",
});

/**
 * One warn per exchange per isolate when a ready WS connection is not used
 * for order placement. WS order placement is intentionally disabled until
 * adapters are fixed end-to-end (method names, BUY/SELL sides, futures
 * endpoints, Bybit/MEXC post-connect auth). Risk of double-fill if a
 * partial WS success falls back to REST.
 */
const wsOrderSkipWarned = new Set<string>();

function warnWsOrderSkippedOnce(exchange: string, detail: string): void {
  if (wsOrderSkipWarned.has(exchange)) return;
  wsOrderSkipWarned.add(exchange);
  logger.warn(
    `WS order placement disabled for ${exchange}; using REST. ${detail}`
  );
}

export class ExchangeConnectionManager extends DurableObject {
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private exchange: string;
  private adapter: IWsAdapter | undefined;
  private ready = false;
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.exchange = this.deriveExchange(ctx);

    // Load the configured adapter for this exchange, if creds are available.
    const creds = resolveExchangeCredentials(this.exchange, env, false);
    if (creds) {
      this.adapter = getAdapter(this.exchange, {
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
      });
      if (!this.adapter) {
        logger.warn(
          `No WS adapter registered for "${this.exchange}"; DO is REST-only`
        );
      }
    } else {
      logger.warn(`Missing ${this.exchange} credentials; DO is REST-only`);
    }

    // Kick off connection in background (safeWaitUntil captures rejections).
    safeWaitUntil(this.ctx, this.connectToExchange(), (err) =>
      logger.error("Background connectToExchange failed", { error: err })
    );
  }

  /**
   * Derive the exchange name from the DO's id name.
   * Caller is expected to use `idFromName("exchange:<name>")`.
   * Falls back to "binance" if the id name doesn't match the pattern
   * (backward compat for tests / accidental raw ids).
   */
  private deriveExchange(ctx: DurableObjectState): string {
    const name = ctx.id.name ?? "";
    const m = name.match(/^exchange:(.+)$/);
    return m?.[1] ?? "binance";
  }

  async connectToExchange() {
    if (this.ws || this.isConnecting) return;
    if (!this.adapter) {
      logger.info(`No adapter for ${this.exchange}; skipping WS connect`);
      return;
    }
    this.isConnecting = true;

    try {
      logger.info(
        `Connecting to ${this.exchange} WebSocket at ${this.adapter.url}`
      );
      const resp = await fetch(this.adapter.url, {
        headers: { Upgrade: "websocket" },
      });

      this.ws = resp.webSocket;
      if (!this.ws) {
        throw new Error("Failed to get WebSocket from response");
      }

      this.ws.accept();
      this.ready = true;

      this.ws.addEventListener("message", (event) => {
        // Keep the DO alive on any incoming message (responses AND push
        // events from user data streams). The connection's overall
        // activity — not just our request/response traffic — proves
        // the DO is in use. Event listeners cannot await; use safeWaitUntil
        // so hibernation does not drop the keepalive alarm and rejections
        // are not floating.
        safeWaitUntil(
          this.ctx,
          this.ctx.storage.setAlarm(Date.now() + 60_000),
          (err) =>
            logger.error("Failed to schedule keepalive alarm", { error: err })
        );

        const raw =
          typeof event === "object" && event !== null && "data" in event
            ? String((event as { data: unknown }).data)
            : String(event);
        const parsed = this.adapter!.parseResponse(raw);
        if (!parsed) return; // push event, ignore for request correlation
        const entry = this.pending.get(parsed.id);
        if (!entry) return;
        this.pending.delete(parsed.id);
        clearTimeout(entry.timer);
        if (parsed.error) {
          entry.reject(new Error(`${parsed.error.code}: ${parsed.error.msg}`));
        } else {
          entry.resolve(parsed.result);
        }
      });

      this.ws.addEventListener("close", () => {
        logger.warn(`${this.exchange} WebSocket closed`);
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("WS closed"));
        }
        this.pending.clear();
        this.ws = null;
        this.ready = false;
        this.isConnecting = false;
        // Event listener cannot await; safeWaitUntil keeps the reconnect alarm.
        safeWaitUntil(
          this.ctx,
          this.ctx.storage.setAlarm(Date.now() + 5000), // Reconnect in 5s
          (err) =>
            logger.error("Failed to schedule reconnect alarm", { error: err })
        );
      });

      this.ws.addEventListener("error", (error) => {
        logger.error(`${this.exchange} WebSocket error`, { error });
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("WS error"));
        }
        this.pending.clear();
        this.ws = null;
        this.ready = false;
        this.isConnecting = false;
      });

      logger.info(`Connected to ${this.exchange} WebSocket`);
      this.isConnecting = false;

      // Set initial alarm
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    } catch (err) {
      logger.error(`Failed to connect to ${this.exchange} WebSocket`, {
        error: err,
      });
      this.isConnecting = false;
      await this.ctx.storage.setAlarm(Date.now() + 10_000); // Try again in 10s
    }
  }

  /**
   * Send a request over the held WebSocket and await the matching response.
   *
   * @throws if the WS is not connected, if the request times out, or if the
   *         exchange returns an error response.
   */
  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 5_000
  ): Promise<unknown> {
    if (!this.ws) throw new Error("WS not connected");
    if (!this.adapter) throw new Error(`No adapter for ${this.exchange}`);

    const envelope = await this.adapter.buildRequest(method, params);
    // Extract the correlation id (Binance/MEXC use `id`, Bybit uses `reqId`).
    const parsed = JSON.parse(envelope) as Record<string, unknown>;
    const key = (parsed.id ?? parsed.reqId) as string | undefined;
    if (typeof key !== "string") {
      throw new Error("Adapter produced no correlation id");
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`WS ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      try {
        this.ws!.send(envelope);
      } catch (err) {
        this.pending.delete(key);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async alarm() {
    if (!this.ws) {
      logger.info("Alarm fired: WebSocket disconnected. Reconnecting...");
      await this.connectToExchange();
    } else {
      // We are connected, just push the alarm forward
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  // RPC Method called by the worker
  async executeTrade(
    payload: WebhookPayload,
    env: Env
  ): Promise<TradeExecutionResult> {
    // Order placement always uses REST. The WS adapters are not safe for
    // live orders: method names (`${exchange}.order.place`), side mapping
    // (LONG/SHORT vs BUY/SELL), product (Binance Spot WS vs futures REST),
    // and missing Bybit/MEXC post-connect auth. Fail-safe: never place
    // via WS here.
    //
    // Adapters + request() remain for connection plumbing / future work;
    // re-enable order placement over WS only after those issues are fixed.
    if (this.ready && this.ws && this.adapter && payload.test !== true) {
      warnWsOrderSkippedOnce(
        this.exchange,
        "executeTrade forces REST (WS order placement disabled)"
      );
    }

    return this.executeTradeRest(payload, env);
  }

  /**
   * REST path. Used as the fallback when WS is not connected, and as the
   * primary path for exchanges that don't yet have a WS adapter.
   */
  private async executeTradeRest(
    payload: WebhookPayload,
    env: Env
  ): Promise<TradeExecutionResult> {
    logger.info(`Executing trade via REST for ${this.exchange}`, { payload });

    const testnet = payload.test === true;
    if (testnet && this.exchange === "mexc") {
      return {
        success: false,
        error:
          "TEST_TRADING_UNSUPPORTED: mexc does not support test/sandbox trading via API",
        status: 400,
      };
    }

    const creds = resolveExchangeCredentials(this.exchange, env, testnet);

    if (!creds) {
      return {
        success: false,
        error: `Missing ${this.exchange}${testnet ? " testnet" : ""} credentials`,
        status: 400,
      };
    }

    const client = this.createRestClient(creds.apiKey, creds.apiSecret, {
      testnet,
    });
    if (!client) {
      return {
        success: false,
        error: `No REST client for ${this.exchange} (WS path is the only option)`,
        status: 400,
      };
    }

    try {
      let result: unknown;
      const { action, symbol, quantity, price, orderType = "MARKET" } = payload;

      switch (action.toUpperCase()) {
        case "LONG":
          result = await client.openLong(symbol, quantity, price, orderType);
          break;
        case "SHORT":
          result = await client.openShort(symbol, quantity, price, orderType);
          break;
        case "CLOSE_LONG":
          result = await client.closeLong(symbol, quantity);
          break;
        case "CLOSE_SHORT":
          result = await client.closeShort(symbol, quantity);
          break;
        default:
          return {
            success: false,
            error: `Invalid action: ${action}`,
            status: 400,
          };
      }

      return { success: true, result, status: 200 };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg, status: 500 };
    }
  }

  /**
   * Construct the REST client for this exchange. Each supported
   * exchange has a dedicated REST client in this worker; this
   * factory selects the right one based on `this.exchange`.
   * Returns `null` for unknown exchanges.
   */
  private createRestClient(
    apiKey: string,
    apiSecret: string,
    options?: { testnet?: boolean }
  ): BinanceClient | BybitClient | MexcClient | null {
    switch (this.exchange) {
      case "binance":
        return new BinanceClient(apiKey, apiSecret, options);
      case "bybit":
        return new BybitClient(apiKey, apiSecret, options);
      case "mexc":
        return new MexcClient(apiKey, apiSecret, options);
      default:
        return null;
    }
  }
}


