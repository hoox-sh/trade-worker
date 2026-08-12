/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { MexcClient } from "./mexc-client";
import { BinanceClient } from "./binance-client";
import { BybitClient } from "./bybit-client";
import type { Env } from "./index";
import type { IExchangeClient } from "./execution";
import type { WebhookPayload } from "@hoox-sh/hoox-shared/types";
import type {
  IExchangeProvider,
  ClientCreateOptions,
  ExchangeRouter as IExchangeRouter,
} from "@hoox-sh/hoox-shared/exchange-client";
import { ExchangeRouter as BaseRouter } from "@hoox-sh/hoox-shared/exchange-client";
import { KVKeys } from "@hoox-sh/hoox-shared/kvKeys";
import { createLogger } from "@hoox-sh/hoox-shared/middleware";
import { toError } from "@hoox-sh/hoox-shared/errors";
import {
  hasExchangeCredentials,
  resolveExchangeCredentials,
  type CredentialSource,
} from "./exchange-credentials";

const logger = createLogger({
  service: "trade-worker",
  module: "exchange-router",
});

/**
 * Order placement over the WS DO path is disabled until adapters are fixed
 * (method names, BUY/SELL sides, futures endpoints, Bybit/MEXC auth).
 * `exchange:<name>:use_websocket=true` is ignored for routing; REST is used.
 * Warn once per exchange per isolate so logs stay quiet under load.
 */
const wsOrderSkipWarned = new Set<string>();

function warnWsOrderSkippedOnce(exchange: string, detail: string): void {
  if (wsOrderSkipWarned.has(exchange)) return;
  wsOrderSkipWarned.add(exchange);
  logger.warn(
    `WS order placement disabled for ${exchange}; routing via REST. ${detail}`
  );
}

// Re-export generic IExchangeProvider for backward compat
export type { IExchangeProvider };

// Re-export worker Env type for execution.ts to use without circular import
export type { Env };

/**
 * Which exchanges expose a public testnet/sandbox trading API.
 * Used for early validation and documentation.
 */
export const EXCHANGE_TEST_SUPPORT: Record<string, boolean> = {
  binance: BinanceClient.supportsTestTrading,
  bybit: BybitClient.supportsTestTrading,
  mexc: MexcClient.supportsTestTrading,
};

/**
 * Module-level factory functions for testability.
 * Use vi.spyOn(factories, "createBinanceClient") etc. in tests to inject mock clients.
 */
export const factories = {
  createBinanceClient(
    apiKey: string,
    apiSecret: string,
    options?: ClientCreateOptions
  ): IExchangeClient {
    return new BinanceClient(apiKey, apiSecret, options);
  },
  createMexcClient(
    apiKey: string,
    apiSecret: string,
    options?: ClientCreateOptions
  ): IExchangeClient {
    return new MexcClient(apiKey, apiSecret, options);
  },
  createBybitClient(
    apiKey: string,
    apiSecret: string,
    options?: ClientCreateOptions
  ): IExchangeClient {
    return new BybitClient(apiKey, apiSecret, options);
  },
};

// Provider type alias bound to trade-worker's types
type TradeExchangeProvider = IExchangeProvider<IExchangeClient, Env>;

function createClientForExchange(
  exchange: string,
  env: Env,
  options?: ClientCreateOptions
): IExchangeClient {
  const testnet = options?.testnet === true;
  const creds = resolveExchangeCredentials(exchange, env, testnet);
  if (!creds) {
    throw new Error(
      testnet
        ? `${exchange} testnet/live API secrets unavailable.`
        : `${exchange} API secrets unavailable.`
    );
  }

  switch (exchange.toLowerCase()) {
    case "binance":
      return factories.createBinanceClient(
        creds.apiKey,
        creds.apiSecret,
        options
      );
    case "bybit":
      return factories.createBybitClient(
        creds.apiKey,
        creds.apiSecret,
        options
      );
    case "mexc":
      return factories.createMexcClient(creds.apiKey, creds.apiSecret, options);
    default:
      throw new Error(`Unsupported exchange: ${exchange}`);
  }
}

export class BinanceProvider implements TradeExchangeProvider {
  readonly name = "binance";
  readonly supportsTestTrading = BinanceClient.supportsTestTrading;
  createClient(env: Env, options?: ClientCreateOptions): IExchangeClient {
    return createClientForExchange("binance", env, options);
  }
  hasCredentials(env: Env): boolean {
    // Live or dedicated testnet keys count as "configured".
    return hasExchangeCredentials("binance", env, false)
      || hasExchangeCredentials("binance", env, true);
  }
}

export class MexcProvider implements TradeExchangeProvider {
  readonly name = "mexc";
  readonly supportsTestTrading = MexcClient.supportsTestTrading;
  createClient(env: Env, options?: ClientCreateOptions): IExchangeClient {
    return createClientForExchange("mexc", env, options);
  }
  hasCredentials(env: Env): boolean {
    return hasExchangeCredentials("mexc", env, false);
  }
}

export class BybitProvider implements TradeExchangeProvider {
  readonly name = "bybit";
  readonly supportsTestTrading = BybitClient.supportsTestTrading;
  createClient(env: Env, options?: ClientCreateOptions): IExchangeClient {
    return createClientForExchange("bybit", env, options);
  }
  hasCredentials(env: Env): boolean {
    return hasExchangeCredentials("bybit", env, false)
      || hasExchangeCredentials("bybit", env, true);
  }
}

export interface RouteResult {
  exchange: string;
  /**
   * REST client for order placement. Always constructed for live trades
   * while WS order placement is disabled (see useWebsocketDO).
   */
  client?: IExchangeClient;
  /**
   * When true, execution would route order placement through the WS DO.
   * Currently always false: `exchange:*:use_websocket` is ignored until
   * adapters are safe (see warn in route()).
   */
  useWebsocketDO?: boolean;
  testnet: boolean;
  /** Which secret binding pair the REST client would use. */
  credentialSource?: CredentialSource;
}

/**
 * Trade-worker-specific ExchangeRouter.
 * Composes the shared generic router and adds KV-based dynamic exchange routing.
 */
export class ExchangeRouter implements Pick<
  IExchangeRouter<IExchangeClient, Env>,
  "registerProvider"
> {
  private readonly baseRouter = new BaseRouter<IExchangeClient, Env>();

  constructor() {
    this.baseRouter.registerProvider(new BinanceProvider());
    this.baseRouter.registerProvider(new MexcProvider());
    this.baseRouter.registerProvider(new BybitProvider());
  }

  registerProvider(provider: IExchangeProvider<IExchangeClient, Env>): void {
    this.baseRouter.registerProvider(provider);
  }

  async route(payload: WebhookPayload, env: Env): Promise<RouteResult> {
    let exchange = payload.exchange.toLowerCase();
    let useWebsocketDO = false;
    const testnet = payload.test === true;

    // Check KV for dynamic routing
    if (env.CONFIG_KV) {
      try {
        const routingTableStr = await env.CONFIG_KV.get(
          KVKeys.KV_TRADE_ROUTING
        );
        if (routingTableStr) {
          const routingTable = JSON.parse(routingTableStr);
          if (routingTable[payload.symbol]) {
            exchange = routingTable[payload.symbol].toLowerCase();
            logger.info("Dynamic route for symbol", {
              symbol: payload.symbol,
              exchange,
            });
          }
        }
      } catch (e) {
        logger.error("Failed to parse routing table from KV", {
          error: toError(e),
        });
      }

      // Check exchange toggle and websocket mode in parallel
      try {
        const [exchangeEnabled, useWs] = await Promise.all([
          env.CONFIG_KV.get(`exchange:${exchange}:enabled`),
          env.CONFIG_KV.get(`exchange:${exchange}:use_websocket`),
        ]);

        if (exchangeEnabled === "false") {
          throw new Error(`EXCHANGE_DISABLED: ${exchange} is disabled`);
        }

        // Order placement over WS is disabled: adapters are not safe
        // (wrong methods/sides, spot vs futures, missing Bybit/MEXC auth).
        // Honor use_websocket=false as REST; when true, force REST and warn
        // once so operators know the flag is intentionally ignored.
        if (useWs === "true" && !testnet) {
          warnWsOrderSkippedOnce(
            exchange,
            "CONFIG exchange:*:use_websocket=true ignored for order placement"
          );
          useWebsocketDO = false;
        }
      } catch (e) {
        // Re-throw EXCHANGE_DISABLED errors, swallow and log KV failures
        if (e instanceof Error && e.message.startsWith("EXCHANGE_DISABLED")) {
          throw e;
        }
        logger.error("Failed to check exchange toggle from KV", {
          error: toError(e),
        });
      }
    }

    if (testnet) {
      if (EXCHANGE_TEST_SUPPORT[exchange] === false) {
        throw new Error(
          `TEST_TRADING_UNSUPPORTED: ${exchange} does not support test/sandbox trading via API`
        );
      }
      logger.info("Test trading enabled for exchange", { exchange });
    }

    const creds = resolveExchangeCredentials(exchange, env, testnet);
    if (!creds) {
      throw new Error(
        `API secret bindings not configured or accessible for ${exchange}`
      );
    }

    // Live WS DO path: skip REST client construction (importKey + object).
    // The DO creates its own client if it falls back to REST.
    if (useWebsocketDO) {
      return {
        exchange,
        useWebsocketDO: true,
        testnet,
        credentialSource: creds.source,
      };
    }

    const client = createClientForExchange(exchange, env, { testnet });
    return {
      exchange,
      client,
      useWebsocketDO: false,
      testnet,
      credentialSource: creds.source,
    };
  }
}
