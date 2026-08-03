/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { DurableObject } from "cloudflare:workers";
import { createLogger } from "@hoox-sh/hoox-shared/middleware";
import type { Env } from "./index";
import { BinanceClient } from "./binance-client";
import { BybitClient } from "./bybit-client";
import { MexcClient } from "./mexc-client";
import type { WebhookPayload } from "@hoox-sh/hoox-shared/types";
import type { TradeExecutionResult } from "./execution";
import { getAdapter } from "./wsAdapters/adapters";
import type { IWsAdapter } from "./wsAdapters/types";

const logger = createLogger({
  service: "trade-worker",
  module: "exchange-connection-manager",
});

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
    const apiKey = readApiKey(env, this.exchange);
    const apiSecret = readApiSecret(env, this.exchange);
    if (apiKey && apiSecret) {
      this.adapter = getAdapter(this.exchange, { apiKey, apiSecret });
      if (!this.adapter) {
        logger.warn(
          `No WS adapter registered for "${this.exchange}"; DO is REST-only`
        );
      }
    } else {
      logger.warn(`Missing ${this.exchange} credentials; DO is REST-only`);
    }

    // Kick off connection in background
    this.ctx.waitUntil(this.connectToExchange());
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
    return m ? m[1] : "binance";
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
        // the DO is in use.
        this.ctx.storage.setAlarm(Date.now() + 60_000);

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
        this.ctx.storage.setAlarm(Date.now() + 5000); // Reconnect in 5s
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
      this.ctx.storage.setAlarm(Date.now() + 60_000);
    } catch (err) {
      logger.error(`Failed to connect to ${this.exchange} WebSocket`, {
        error: err,
      });
      this.isConnecting = false;
      this.ctx.storage.setAlarm(Date.now() + 10_000); // Try again in 10s
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
      this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  // RPC Method called by the worker
  async executeTrade(
    payload: WebhookPayload,
    env: Env
  ): Promise<TradeExecutionResult> {
    // Test trading uses dedicated REST testnet hosts. Live WS adapters
    // always target mainnet — never place a test order over a live socket.
    if (payload.test === true) {
      return this.executeTradeRest(payload, env);
    }

    // Try the WS path first if the connection is ready.
    if (this.ready && this.ws && this.adapter) {
      try {
        const params: Record<string, unknown> = {
          symbol: payload.symbol,
          side: payload.action.toUpperCase(),
          type: payload.orderType ?? "MARKET",
          quantity: payload.quantity,
          price: payload.price,
        };
        const result = await this.request(
          `${this.exchange}.order.place`,
          params
        );
        return { success: true, result, status: 200 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`WS execution failed, falling back to REST: ${msg}`);
        // fall through to REST
      }
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

    const apiKey = readApiKey(env, this.exchange, testnet);
    const apiSecret = readApiSecret(env, this.exchange, testnet);

    if (!apiKey || !apiSecret) {
      return {
        success: false,
        error: `Missing ${this.exchange}${testnet ? " testnet" : ""} credentials`,
        status: 400,
      };
    }

    const client = this.createRestClient(apiKey, apiSecret, { testnet });
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

/**
 * Read the API key env binding for the given exchange.
 * When testnet is true, prefer dedicated testnet bindings.
 * Returns "" if the binding is missing.
 */
function readApiKey(env: Env, exchange: string, testnet = false): string {
  if (testnet) {
    switch (exchange) {
      case "bybit":
        return (
          env.BYBIT_TESTNET_KEY_BINDING ||
          env.BYBIT_KEY_BINDING ||
          ""
        );
      case "binance":
        return (
          env.BINANCE_TESTNET_KEY_BINDING ||
          env.BINANCE_KEY_BINDING ||
          ""
        );
      case "mexc":
        return env.MEXC_KEY_BINDING ?? "";
      default:
        return "";
    }
  }
  switch (exchange) {
    case "bybit":
      return env.BYBIT_KEY_BINDING ?? "";
    case "mexc":
      return env.MEXC_KEY_BINDING ?? "";
    case "binance":
    default:
      return env.BINANCE_KEY_BINDING ?? "";
  }
}

/**
 * Read the API secret env binding for the given exchange.
 * When testnet is true, prefer dedicated testnet bindings.
 * Returns "" if the binding is missing.
 */
function readApiSecret(env: Env, exchange: string, testnet = false): string {
  if (testnet) {
    switch (exchange) {
      case "bybit":
        return (
          env.BYBIT_TESTNET_SECRET_BINDING ||
          env.BYBIT_SECRET_BINDING ||
          ""
        );
      case "binance":
        return (
          env.BINANCE_TESTNET_SECRET_BINDING ||
          env.BINANCE_SECRET_BINDING ||
          ""
        );
      case "mexc":
        return env.MEXC_SECRET_BINDING ?? "";
      default:
        return "";
    }
  }
  switch (exchange) {
    case "bybit":
      return env.BYBIT_SECRET_BINDING ?? "";
    case "mexc":
      return env.MEXC_SECRET_BINDING ?? "";
    case "binance":
    default:
      return env.BINANCE_SECRET_BINDING ?? "";
  }
}
