/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/trade-worker/src/execution.ts
// Core trade execution logic extracted from index.ts

import {
  authenticatedServiceFetch,
  D1_WRITE_AUTH_KEY_FIELDS,
  resolveInternalAuthKey,
} from "@jango-blockchained/hoox-shared/service-bindings";
import {
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import type { WebhookPayload } from "@jango-blockchained/hoox-shared/types";
import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import { KVKeys } from "@jango-blockchained/hoox-shared/kvKeys";
import type { IDbLogger } from "./db-logger";
import { ExchangeRouter, type Env } from "./exchange-router";
import { sendTradeNotificationToTelegram } from "./notifications";

const logger = createLogger({ service: "trade-worker", module: "execution" });

/** Reuse router across requests — providers are registered once per isolate. */
const exchangeRouter = new ExchangeRouter();

// --- Type Definitions ---

/**
 * Minimal environment interface for trade execution operations.
 * Only includes the bindings needed by the extracted execution functions
 * and their transitive dependencies (ExchangeRouter, trackAnalytics, etc.).
 */
export interface ExecutionEnv {
  CONFIG_KV?: KVNamespace;
  D1_SERVICE?: Fetcher;
  INTERNAL_KEY_BINDING?: string;
  TELEGRAM_SERVICE?: Fetcher;
  TELEGRAM_INTERNAL_KEY_BINDING?: string;
  MEXC_KEY_BINDING?: string;
  MEXC_SECRET_BINDING?: string;
  BINANCE_KEY_BINDING?: string;
  BINANCE_SECRET_BINDING?: string;
  /** Optional dedicated Binance Futures testnet key (preferred when test:true). */
  BINANCE_TESTNET_KEY_BINDING?: string;
  BINANCE_TESTNET_SECRET_BINDING?: string;
  BYBIT_KEY_BINDING?: string;
  BYBIT_SECRET_BINDING?: string;
  /** Optional dedicated Bybit testnet key (preferred when test:true). */
  BYBIT_TESTNET_KEY_BINDING?: string;
  BYBIT_TESTNET_SECRET_BINDING?: string;
}

// Generic client interface (mirrored from index.ts to avoid circular dependency)
export interface IExchangeClient {
  getAccountInfo: () => Promise<Record<string, unknown>>;
  setLeverage?: (symbol: string, leverage: number) => Promise<void>;
  openLong: (
    symbol: string,
    quantity: number,
    price?: number,
    orderType?: string
  ) => Promise<unknown>;
  openShort: (
    symbol: string,
    quantity: number,
    price?: number,
    orderType?: string
  ) => Promise<unknown>;
  closeLong: (symbol: string, quantity: number) => Promise<unknown>;
  closeShort: (symbol: string, quantity: number) => Promise<unknown>;
}

// Note: IExchangeClient uses `unknown` for the trade operation return types
// because each exchange (MEXC, Bybit, Binance) returns a different response
// shape from its respective REST API. The runtime type is exchange-specific
// (see mexc-client.ts, bybit-client.ts, binance-client.ts). The base class
// in @jango-blockchained/hoox-shared/exchanges uses OrderResponse for
// `executeTrade` and `Position[]` for `getPositions`.

interface ValidationResult {
  isValid: boolean;
  error?: string;
}

// --- Helper Functions ---

/**
 * Updates D1 database with trade and position records
 *
 * Both D1 writes (trades + positions) are dispatched via
 * `ctx.waitUntil(...)` so they run in the background after the
 * HTTP response is sent. This is the key change for the
 * 2026-06-27 fastpath optimization: previously these writes
 * blocked the response (two awaited service-binding round-trips
 * to d1-worker, each ~30-50ms at the edge). With fire-and-forget
 * the response returns as soon as the exchange API call completes.
 *
 * Trade-off: if the worker is killed (e.g. eviction, deploy)
 * before the writes complete, the trade records can be lost.
 * Mitigation: the `ctx.waitUntil` promise is logged on failure
 * so a missing record is visible in logs, and the underlying
 * exchange API call is the source of truth for "did the trade
 * actually execute" (the response shape is preserved in
 * triggerReportSave's R2 dump).
 */
export async function updateD1TradeRecords(
  env: ExecutionEnv,
  result: unknown,
  payload: WebhookPayload,
  routedExchange: string,
  overriddenLeverage: number | undefined,
  ctx?: ExecutionContext
): Promise<void> {
  if (!env.D1_SERVICE) return;

  try {
    const tradeId = crypto.randomUUID();
    const { action, symbol, quantity, price, test } = payload;
    const isTest = test === true;
    // Keep testnet fills out of the live ledger status vocabulary so
    // reporting/agent paths can filter them without a schema migration.
    const tradeStatus = isTest ? "TEST_EXECUTED" : "EXECUTED";

    const side = action.includes("LONG") ? "LONG" : "SHORT";
    const posStatus = action.startsWith("CLOSE") ? "CLOSED" : "OPEN";
    // Namespace position IDs so testnet opens never clobber live exposure.
    const posId = isTest
      ? `${routedExchange}-testnet-${symbol}-${side}`
      : `${routedExchange}-${symbol}-${side}`;

    // Fail closed: require a D1 write key (scoped or legacy full key)
    if (!resolveInternalAuthKey(env, D1_WRITE_AUTH_KEY_FIELDS)) {
      logger.error(
        "D1 write auth key not configured, cannot update D1 trade records"
      );
      return;
    }

    // Named D1 RPC endpoints (fixed SQL templates) — prefer over free-form /query
    const tradeWrite = authenticatedServiceFetch(
      env.D1_SERVICE,
      env,
      "/rpc/insert-trade",
      {
        id: tradeId,
        timestamp: Math.floor(Date.now() / 1000),
        exchange: routedExchange,
        symbol,
        action,
        quantity,
        price: price || null,
        leverage: overriddenLeverage || null,
        status: tradeStatus,
        raw_response: result,
      },
      { internalKeyFields: D1_WRITE_AUTH_KEY_FIELDS }
    ).catch((err) => {
      logger.error("Background D1 trade-record write failed", {
        tradeId,
        error: toError(err),
      });
    });
    const posWrite = authenticatedServiceFetch(
      env.D1_SERVICE,
      env,
      "/rpc/upsert-position",
      {
        id: posId,
        exchange: routedExchange,
        symbol,
        side,
        size: posStatus === "OPEN" ? quantity : 0,
        status: posStatus,
        updated_at: Math.floor(Date.now() / 1000),
      },
      { internalKeyFields: D1_WRITE_AUTH_KEY_FIELDS }
    ).catch((err) => {
      logger.error("Background D1 position-record write failed", {
        positionId: posId,
        error: toError(err),
      });
    });

    if (ctx) {
      // Non-blocking: the response returns to the caller immediately
      // while the D1 writes happen in the background. ctx.waitUntil
      // keeps the worker alive until both writes settle.
      ctx.waitUntil(Promise.all([tradeWrite, posWrite]));
    } else {
      // Fallback for callers without an ExecutionContext (tests,
      // internal callers): block until the writes complete so we
      // don't drop them on the floor.
      await Promise.all([tradeWrite, posWrite]);
    }
  } catch (error: unknown) {
    logger.error("Failed to update D1 trades and positions tables", {
      error: toError(error),
    });
  }
}

/**
 * Checks if API credentials seem configured for a given exchange.
 */
export function validateApiCredentials(
  exchange: string,
  env: ExecutionEnv
): boolean {
  const checkBinding = (
    keyBinding?: string,
    secretBinding?: string
  ): boolean => {
    return !!keyBinding && !!secretBinding;
  };

  switch (exchange.toLowerCase()) {
    case "mexc":
      return checkBinding(env.MEXC_KEY_BINDING, env.MEXC_SECRET_BINDING);
    case "binance":
      return checkBinding(env.BINANCE_KEY_BINDING, env.BINANCE_SECRET_BINDING);
    case "bybit":
      return checkBinding(env.BYBIT_KEY_BINDING, env.BYBIT_SECRET_BINDING);
    default:
      return false;
  }
}

/**
 * Validates the core trade payload structure and content.
 */
export function validateTradePayload(payload: unknown): ValidationResult {
  // Use unknown initially, then refine
  if (!payload || typeof payload !== "object") {
    return { isValid: false, error: "Invalid or missing payload" };
  }

  const wp = payload as WebhookPayload;
  const { exchange, action, symbol, quantity } = wp;

  if (
    !exchange ||
    !action ||
    !symbol ||
    quantity === undefined ||
    quantity === null
  ) {
    return { isValid: false, error: "Missing required fields in payload" };
  }

  const validActions: WebhookPayload["action"][] = [
    "LONG",
    "SHORT",
    "CLOSE_LONG",
    "CLOSE_SHORT",
  ];
  if (
    !validActions.includes(action.toUpperCase() as WebhookPayload["action"])
  ) {
    return { isValid: false, error: `Invalid action in payload: ${action}` };
  }

  if (typeof quantity !== "number" || isNaN(quantity) || quantity <= 0) {
    return { isValid: false, error: "Invalid quantity in payload" };
  }

  // Add further checks (e.g., price/leverage types if present)
  if (
    wp.price !== undefined &&
    (typeof wp.price !== "number" || isNaN(wp.price))
  ) {
    return { isValid: false, error: "Invalid price in payload" };
  }
  if (
    wp.leverage !== undefined &&
    (typeof wp.leverage !== "number" ||
      isNaN(wp.leverage) ||
      !Number.isInteger(wp.leverage) ||
      wp.leverage <= 0)
  ) {
    return { isValid: false, error: "Invalid leverage in payload" };
  }

  return { isValid: true };
}

// --- Core Trade Execution Logic ---

/**
 * Structured result from trade execution, avoiding raw Response passing.
 */
export interface TradeExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string | null;
  /** HTTP status code appropriate for this result (e.g. 200, 400, 500) */
  status?: number;
}

/**
 * Core logic to process a validated trade payload.
 */
export async function executeTrade(
  payload: WebhookPayload,
  env: Env,
  dbLogger: IDbLogger,
  startTime: number,
  dbLogId: string | null,
  ctx: ExecutionContext
): Promise<TradeExecutionResult> {
  try {
    const {
      exchange,
      action,
      symbol,
      quantity,
      price,
      orderType = "MARKET",
      leverage,
      test,
    } = payload;
    const testnet = test === true;

    let overriddenLeverage = leverage;
    let maxPositionSize: number | null = null;

    // --- Kill Switch & Risk Management via CONFIG_KV ---
    // Kill switch is FAIL-CLOSED: missing CONFIG_KV or KV read failure
    // halts trading. Risk knobs (leverage/size) remain fail-open with
    // safe defaults so a partial config outage does not invent caps.
    if (!env.CONFIG_KV) {
      throw new Error(
        "KILL_SWITCH_ACTIVE: CONFIG_KV not configured — trading halted (fail-closed)"
      );
    }
    try {
      const [killSwitch, defaultLevStr, maxSizeStr] = await Promise.all([
        env.CONFIG_KV.get(KVKeys.KV_TRADE_KILL_SWITCH),
        env.CONFIG_KV.get(KVKeys.KV_TRADE_DEFAULT_LEVERAGE),
        env.CONFIG_KV.get(KVKeys.KV_TRADE_MAX_POSITION_SIZE),
      ]);

      if (killSwitch === "true") {
        throw new Error(
          "KILL_SWITCH_ACTIVE: Trading is disabled by kill switch"
        );
      }

      // Parse leverage safely. A malformed KV value (empty string,
      // "abc", etc.) yields NaN from parseInt; NaN bypasses every
      // later bound check (NaN > anyNumber === false), silently
      // disabling the per-trade leverage cap. The same is true for
      // parseFloat on the position-size KV value.
      if (defaultLevStr && !overriddenLeverage) {
        const parsedLev = parseInt(defaultLevStr, 10);
        if (Number.isFinite(parsedLev) && parsedLev > 0) {
          overriddenLeverage = parsedLev;
          logger.info(
            `[Risk Management] Applied default leverage: ${overriddenLeverage}`
          );
        } else {
          logger.warn(
            `[Risk Management] Ignoring malformed default_leverage value: ${JSON.stringify(defaultLevStr)}`
          );
        }
      }
      if (maxSizeStr) {
        const parsedSize = parseFloat(maxSizeStr);
        if (Number.isFinite(parsedSize) && parsedSize > 0) {
          maxPositionSize = parsedSize;
        } else {
          logger.warn(
            `[Risk Management] Ignoring malformed max_position_size value: ${JSON.stringify(maxSizeStr)}`
          );
        }
      }
    } catch (e) {
      // Re-throw kill switch / fail-closed errors; also fail-closed on
      // unexpected KV failures (cannot verify kill switch state).
      if (e instanceof Error && e.message.startsWith("KILL_SWITCH_ACTIVE")) {
        throw e;
      }
      logger.error(
        "Failed to fetch trade settings from KV — halting trade (fail-closed)",
        { error: toError(e) }
      );
      throw new Error(
        `KILL_SWITCH_ACTIVE: Unable to verify kill switch (${toError(e)})`,
        { cause: e }
      );
    }
    // --- End Kill Switch & Risk Management ---

    if (maxPositionSize !== null && quantity > maxPositionSize) {
      const errorMsg = `Trade quantity (${quantity}) exceeds maximum allowed size (${maxPositionSize})`;
      logger.error(errorMsg);
      const result: TradeExecutionResult = {
        success: false,
        error: errorMsg,
        status: 400,
      };
      await dbLogger.logResponse(
        dbLogId,
        createJsonResponse(result, 400),
        null,
        startTime,
        ctx
      );
      return result;
    }
    // --- End Risk Management ---

    let client: IExchangeClient | undefined;
    let routedExchange: string;
    let useWebsocketDO = false;
    let credentialSource: "testnet" | "live" | undefined;

    try {
      const routeResult = await exchangeRouter.route(payload, env);
      client = routeResult.client;
      routedExchange = routeResult.exchange;
      useWebsocketDO = routeResult.useWebsocketDO || false;
      credentialSource = routeResult.credentialSource;
    } catch (error: unknown) {
      const errorMsg = toError(error, `Failed to route exchange: ${exchange}`);
      logger.error(errorMsg);
      // Unsupported test trading is a client error (400); other routing
      // failures also stay 400 so callers can fix the payload/config.
      const result: TradeExecutionResult = {
        success: false,
        error: errorMsg,
        status: 400,
      };
      await dbLogger.logResponse(
        dbLogId,
        createJsonResponse(result, 400),
        null,
        startTime,
        ctx
      );
      return result;
    }

    if (testnet) {
      if (credentialSource === "live") {
        logger.warn(
          "Test trading with live API key bindings against testnet hosts. Prefer BINANCE_TESTNET_* / BYBIT_TESTNET_* secrets.",
          { exchange: routedExchange, symbol, action }
        );
      } else {
        logger.info("Test trading with dedicated testnet API key bindings", {
          exchange: routedExchange,
          symbol,
          action,
        });
      }
    }

    let result: unknown;

    // Test trades always use REST testnet endpoints — never the live WS DO.
    // Live WS path: route() skips REST client construction (perf).
    if (useWebsocketDO && !testnet && env.EXCHANGE_CONNECTION_MANAGER) {
      logger.info(`Routing trade to DO for ${routedExchange}`);
      const id = env.EXCHANGE_CONNECTION_MANAGER.idFromName(
        `exchange:${routedExchange}`
      );
      // DurableObjectStub is an RPC proxy — cast to access RPC methods
      const stub = env.EXCHANGE_CONNECTION_MANAGER.get(id) as unknown as {
        executeTrade(
          payload: WebhookPayload,
          env: Env
        ): Promise<TradeExecutionResult>;
      };
      const doResult = await stub.executeTrade(payload, env);
      if (!doResult.success) {
        throw new Error(doResult.error || "DO execution failed");
      }
      result = doResult.result;
    } else {
      if (!client) {
        throw new Error(
          `No REST client available for ${routedExchange} (unexpected route result)`
        );
      }
      if (client.setLeverage && overriddenLeverage) {
        try {
          await client.setLeverage(symbol, overriddenLeverage);
        } catch (leverageError) {
          logger.error("Failed to set leverage", {
            error: toError(leverageError),
          });
          // Continue with trade execution even if setting leverage fails
        }
      }

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
        // No default needed due to validation earlier
      }
    }

    // Extended hop instrumentation for measurement / traces.
    // Real outbound RTT (sign + TLS + exchange processing) is captured here
    // or via per-client timing and Analytics events carrying probe_id.
    logger.debug("Trade execution successful", { result });

    // Update D1 tables with trade and position data
    if (env.D1_SERVICE) {
      // Pass ctx so updateD1TradeRecords can dispatch the writes
      // via ctx.waitUntil(...) instead of blocking the response.
      await updateD1TradeRecords(
        env,
        result,
        payload,
        routedExchange,
        overriddenLeverage,
        ctx
      );
    }

    const tradeResult: TradeExecutionResult = {
      success: true,
      result,
      error: null,
      status: 200,
    };
    await dbLogger.logResponse(
      dbLogId,
      createJsonResponse(tradeResult),
      null,
      startTime,
      ctx
    );

    // Track trade analytics (non-blocking)
    const latencyMs = Date.now() - startTime;
    ctx.waitUntil(
      trackAnalytics(env, "/track/trade", {
        payload: {
          exchange: routedExchange,
          action,
          symbol,
          quantity,
          price,
          test: testnet || undefined,
        },
        result: { success: true },
        latencyMs,
      }).catch((err) =>
        logger.error("trackAnalytics failed", { error: String(err) })
      )
    );

    // Send notification via telegram-worker after trade execution (non-blocking)
    if (env.TELEGRAM_SERVICE) {
      const exchangeLabel = testnet ? `${routedExchange} [TEST]` : routedExchange;
      ctx.waitUntil(
        sendTradeNotificationToTelegram(
          env,
          result as { success?: boolean; result?: unknown; error?: string },
          exchangeLabel,
          action,
          quantity,
          symbol,
          dbLogId
        ).catch((err) =>
          logger.error("Send notification failed", { error: toError(err) })
        )
      );
    }

    return tradeResult;
  } catch (error: unknown) {
    const errorMsg = toError(error, "Internal server error");
    logger.error("Error in executeTrade", { errorMsg, error: toError(error) });
    const tradeResult: TradeExecutionResult = {
      success: false,
      error: `Trade execution failed: ${errorMsg}`,
      status: 500,
    };
    const response = createJsonResponse(tradeResult, 500);
    // Log failure response, even if dbLogId might be null in edge cases
    if (dbLogger && dbLogId !== null) {
      try {
        await dbLogger.logResponse(dbLogId, response, null, startTime, ctx);
      } catch (logErr) {
        logger.error("Failed to log error response to D1", {
          error: toError(logErr),
        });
      }
    }

    // Track failed trade analytics (non-blocking)
    const latencyMs = Date.now() - startTime;
    ctx.waitUntil(
      trackAnalytics(env, "/track/trade", {
        payload: {
          exchange: payload.exchange,
          action: payload.action,
          symbol: payload.symbol,
          quantity: payload.quantity,
          price: payload.price,
          test: payload.test === true ? true : undefined,
        },
        result: { success: false, error: errorMsg },
        latencyMs,
      }).catch((err) =>
        logger.error("trackAnalytics failed", { error: String(err) })
      )
    );

    return tradeResult;
  }
}
