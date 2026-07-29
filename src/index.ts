/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

import { DbLogger } from "./db-logger";

import {
  Errors,
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import {
  createLogger,
  withRequestLog,
  validateJson,
  requireInternalAuth,
  type InternalAuthEnv,
} from "@jango-blockchained/hoox-shared/middleware";
import { createRouter } from "@jango-blockchained/hoox-shared/router";
import { createQueueHandler } from "@jango-blockchained/hoox-shared/queue-handler";
import { TradeQueueMessageSchema } from "@jango-blockchained/hoox-shared";
import {
  WebhookPayload,
  WebhookPayloadSchema,
  ProcessRequestBody,
} from "@jango-blockchained/hoox-shared/types";
import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import { healthCheck } from "@jango-blockchained/hoox-shared/health";
import {
  authenticatedServiceFetch,
  D1_WRITE_AUTH_KEY_FIELDS,
  TRADE_EXECUTE_AUTH_KEY_FIELDS,
  resolveInternalAuthKey,
} from "@jango-blockchained/hoox-shared/service-bindings";
import {
  executeTrade,
  type ExecutionEnv,
  type TradeExecutionResult,
} from "./execution";
import {
  handlePostSignalRequest,
  handleGetSignalsRequest,
  type D1Env,
} from "./signals";
import { saveReportToR2, handleGetReportRequest } from "./reports";
import { sendTradeNotification, TradeQueueMessage } from "./notifications";
import { ExchangeConnectionManager } from "./exchange-connection-manager";

export { ExchangeConnectionManager };

// --- Type Definitions ---

export interface Env extends Cloudflare.Env {
  EXCHANGE_CONNECTION_MANAGER: DurableObjectNamespace<ExchangeConnectionManager>;
  /** Optional dedicated testnet API keys (preferred when payload.test is true). */
  BINANCE_TESTNET_KEY_BINDING?: string;
  BINANCE_TESTNET_SECRET_BINDING?: string;
  BYBIT_TESTNET_KEY_BINDING?: string;
  BYBIT_TESTNET_SECRET_BINDING?: string;
}

/**
 * Shared error handling utility for request handlers.
 * Centralizes error logging and response creation to avoid duplication.
 */
async function handleError(
  error: unknown,
  dbLogger: DbLogger,
  dbLogId: string | null,
  startTime: number,
  request: Request,
  context: string,
  ctx?: ExecutionContext
): Promise<Response> {
  const errorMsg = toError(error, `Failed to ${context}`);
  logger.error(`Error in ${context}`, { error: errorMsg });
  const response = Errors.internal(errorMsg);

  // Log error response if dbLogId was obtained
  if (dbLogId !== null) {
    const errObj = error instanceof Error ? error : new Error(toError(error));
    await dbLogger.logResponse(dbLogId, response, errObj, startTime, ctx);
  } else {
    // Body already consumed, log URL and method instead
    try {
      logger.error("Failed to capture request body after error", {
        url: request.url,
        method: request.method,
      });
      const fallbackLogId = await dbLogger.logRequest(
        request,
        `[body consumed] ${request.url}`,
        ctx
      );
      const errObj = error instanceof Error ? error : new Error(toError(error));
      await dbLogger.logResponse(
        fallbackLogId,
        response,
        errObj,
        startTime,
        ctx
      );
    } catch (logError: unknown) {
      logger.error("Failed to log error response after initial failure", {
        error: toError(logError),
      });
    }
  }
  return response;
}

// Payload structure for legacy /process requests
type TradeProcessRequestBody = ProcessRequestBody<WebhookPayload>;

/**
 * Module-level factory function for testability.
 * Use vi.spyOn(factories, "createDbLogger") in tests to inject a mock DbLogger.
 */
export const factories = {
  createDbLogger(env: ExecutionEnv): DbLogger {
    return new DbLogger(env);
  },
};

// --- Constants ---
const MAX_RETRIES = 5;
const BACKOFF_DELAYS = [0, 30, 60, 300, 900]; // 0s, 30s, 1m, 5m, 15m

const PROCESS_ENDPOINT = "/process"; // For legacy/direct calls with internal key
const WEBHOOK_ENDPOINT = "/webhook"; // For calls from hoox via Service Binding
const SIGNALS_ENDPOINT = "/api/signals"; // New endpoint for D1 signals

function tradeExecuteAuthConfigError(): Response {
  return Errors.internal("Service configuration error");
}

function requireTradeExecuteAuth(request: Request, env: Env): Response | null {
  if (!resolveInternalAuthKey(env, TRADE_EXECUTE_AUTH_KEY_FIELDS)) {
    return tradeExecuteAuthConfigError();
  }
  return requireInternalAuth(
    request,
    env as unknown as InternalAuthEnv,
    TRADE_EXECUTE_AUTH_KEY_FIELDS
  );
}

// --- Queue Consumer Helper Functions ---

async function executeTradeFromQueue(
  trade: TradeQueueMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    const payload: WebhookPayload = {
      exchange: trade.exchange,
      action: trade.action as WebhookPayload["action"],
      symbol: trade.symbol,
      quantity: trade.quantity,
      price: trade.price,
      leverage: trade.leverage,
      test: trade.test,
    };

    const dbLogger = factories.createDbLogger(env as ExecutionEnv);
    const startTime = Date.now();
    const tradeResult = await executeTrade(
      payload,
      env,
      dbLogger,
      startTime,
      null,
      ctx
    );

    return {
      success: tradeResult.success ?? false,
      result: tradeResult.result,
      error: tradeResult.error || undefined,
    };
  } catch (error: unknown) {
    return { success: false, error: toError(error) };
  }
}

async function logFailedTrade(
  trade: TradeQueueMessage,
  errorMsg: string,
  env: Env
): Promise<void> {
  try {
    if (env.D1_SERVICE) {
      if (!resolveInternalAuthKey(env, D1_WRITE_AUTH_KEY_FIELDS)) {
        logger.error(
          "D1 write auth key not configured, cannot log failed trade"
        );
        return;
      }

      await authenticatedServiceFetch(
        env.D1_SERVICE,
        env,
        "/rpc/insert-system-log",
        {
          level: "ERROR",
          source: "queue-consumer",
          message: `Trade failed: ${trade.requestId}`,
          details: { trade, error: errorMsg },
        },
        { internalKeyFields: D1_WRITE_AUTH_KEY_FIELDS }
      );
    }
  } catch (error: unknown) {
    logger.error("Failed to log failed trade", { error: toError(error) });
  }
}

// --- Worker Definition ---

const logger = createLogger({ service: "trade-worker", module: "router" });

/**
 * Helper: queue R2 report save on successful trade execution.
 * Extracted to avoid duplicating this pattern across webhook + process handlers.
 */
function triggerReportSave(
  tradeResult: TradeExecutionResult,
  payload: WebhookPayload,
  dbLogId: string | null,
  env: Env,
  ctx: ExecutionContext,
  requestId: string | undefined
): void {
  if (tradeResult.success) {
    logger.info(`[${requestId}] Trade successful, queueing report save to R2.`);
    ctx.waitUntil(
      saveReportToR2(tradeResult.result, payload, dbLogId, env).catch((e) => {
        logger.error(`[${requestId}] Report save failed`, {
          error: toError(e),
        });
      })
    );
  }
}

const router = createRouter<Env>();

// Define routes
router.get(
  "/health",
  async (_request: Request, _env: Env, _ctx: ExecutionContext) => {
    return healthCheck({ worker: "trade-worker" });
  }
);

router.get(
  SIGNALS_ENDPOINT,
  async (request: Request, env: Env, _ctx: ExecutionContext) => {
    return await handleGetSignalsRequest(request, env as unknown as D1Env);
  }
);

router.post(
  SIGNALS_ENDPOINT,
  async (request: Request, env: Env, _ctx: ExecutionContext) => {
    return await handlePostSignalRequest(request, env as unknown as D1Env);
  }
);

router.post(
  WEBHOOK_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    return await handleWebhookRequest(request, env, ctx);
  }
);

router.post(
  PROCESS_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    return await handleProcessRequest(request, env, ctx);
  }
);

router.get(
  "/report",
  async (request: Request, env: Env, _ctx: ExecutionContext) => {
    return await handleGetReportRequest(request, env);
  }
);

export default {
  fetch: withRequestLog(
    (request: Request, env: Env, ctx: ExecutionContext) => {
      return router.handle(request, env, ctx);
    },
    { service: "trade-worker", module: "router" }
  ),

  async queue(
    batch: MessageBatch<TradeQueueMessage>,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const handler = createQueueHandler<TradeQueueMessage>({
      maxRetries: MAX_RETRIES,
      backoffDelays: BACKOFF_DELAYS,
      logger,
      onMessage: async (trade, _attemptNumber) => {
        const parsed = TradeQueueMessageSchema.safeParse(trade);
        if (!parsed.success) {
          throw new Error("Invalid trade queue message");
        }
        const result = await executeTradeFromQueue(parsed.data, env, ctx);
        if (!result.success) {
          throw new Error(result.error || "Trade execution failed");
        }
        // Success notifications are already sent inside executeTrade
        // (with [TEST] labeling when applicable). Do not double-notify.
      },
      onRetry: (_trade, _attemptNumber, _errorMsg, _delaySeconds) => {
        // Logging is handled by createQueueHandler internally
      },
      onDLQ: async (trade, _attemptNumber, errorMsg) => {
        await logFailedTrade(trade, errorMsg, env);
        // Failure path never reached executeTrade success notify — alert once.
        await sendTradeNotification(trade, env, {
          success: false,
          error: errorMsg,
        });
      },
    });

    return await handler(batch);
  },
};

// --- Request Handlers ---

/**
 * Handles POST requests to the /webhook endpoint (from service bindings).
 */
async function handleWebhookRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  const dbLogger = factories.createDbLogger(env as ExecutionEnv);
  let dbLogId: string | null = null;
  const incomingRequestId =
    request.headers.get("X-Request-ID") || crypto.randomUUID();

  try {
    const authError = requireTradeExecuteAuth(request, env);
    if (authError) {
      if (authError.status === 500) {
        try {
          dbLogId = await dbLogger.logRequest(
            request,
            `[config error] ${request.url}`,
            ctx
          );
          await dbLogger.logResponse(dbLogId, authError, null, startTime, ctx);
        } catch {
          // Ignore logging failures for config errors
        }
        return authError;
      }
      logger.warn(
        `Authentication failed for webhook request ID: ${incomingRequestId}`
      );
      // Log auth failure
      try {
        dbLogId = await dbLogger.logRequest(
          request,
          `[auth failed] ${request.url}`,
          ctx
        );
        await dbLogger.logResponse(dbLogId, authError, null, startTime, ctx);
      } catch {
        // Ignore logging failures for auth errors
      }
      return authError;
    }

    // Parse body after auth check
    const payload: WebhookPayload = await request.json();
    logger.info(`Processing webhook request ID: ${incomingRequestId}`);
    logger.debug("Received webhook payload", { payload });

    // Assuming logRequest can handle the payload directly and returns a number ID
    // Might need adjustment based on DbLogger implementation
    dbLogId = await dbLogger.logRequest(request, payload, ctx);

    // Probe short-circuit: check raw payload before validation (probe is a control signal, not a trade)
    if ((payload as Record<string, unknown>).probe === true) {
      const tHopStart = performance.now();
      const probeId = String(
        (payload as Record<string, unknown>).probe_id ?? ""
      );
      ctx.waitUntil(
        trackAnalytics(
          env,
          "/track/api-call",
          {
            worker: "trade-worker",
            endpoint: "/webhook",
            latencyMs: 0,
            success: true,
          },
          { indexes: [probeId] }
        )
      );
      const twHopMs = performance.now() - tHopStart;
      console.log(
        JSON.stringify({
          probe_id: probeId,
          hop: "trade-worker-receive",
          duration_ms: Math.round(twHopMs),
        })
      );
      // Note: signing + outbound time is measured in executeTrade when a real
      // trade occurs (or via separate health probes). Extended instrumentation
      // emits additional "trade-sign" and "trade-outbound" hops for traces.
      return new Response(
        JSON.stringify({ ok: true, probe_id: probeId, status: "probed" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const validation = validateJson(WebhookPayloadSchema, payload);
    if (!validation.ok) {
      const response = Errors.badRequest(validation.error);
      await dbLogger.logResponse(dbLogId, response, null, startTime, ctx);
      return response;
    }

    // *** Use validated payload ***
    const validatedPayload = validation.value;

    // *** Call executeTrade ***
    const tradeResult = await executeTrade(
      validatedPayload,
      env,
      dbLogger,
      startTime,
      dbLogId,
      ctx
    );
    const tradeResponse = createJsonResponse(
      tradeResult,
      tradeResult.status ?? (tradeResult.success ? 200 : 500)
    );

    // Queue R2 report save (if trade was successful) — fire-and-forget
    triggerReportSave(
      tradeResult,
      validatedPayload,
      dbLogId,
      env,
      ctx,
      incomingRequestId
    );

    // Track API call analytics (non-blocking)
    const webhookLatencyMs = Date.now() - startTime;
    ctx.waitUntil(
      trackAnalytics(env, "/track/api-call", {
        worker: "trade-worker",
        endpoint: "/webhook",
        latencyMs: webhookLatencyMs,
        success: tradeResult.success,
      }).catch((err) =>
        logger.error("trackAnalytics failed", { error: String(err) })
      )
    );

    return tradeResponse;
  } catch (error: unknown) {
    return handleError(
      error,
      dbLogger,
      dbLogId,
      startTime,
      request,
      "handleWebhookRequest",
      ctx
    );
  }
}

/**
 * Handles the standardized processing request (/process endpoint).
 */
async function handleProcessRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  const dbLogger = factories.createDbLogger(env as ExecutionEnv);
  let dbLogId: string | null = null;
  let incomingRequestId: string | undefined;

  try {
    const authError = requireTradeExecuteAuth(request, env);
    if (authError) {
      if (authError.status === 500) {
        try {
          dbLogId = await dbLogger.logRequest(
            request,
            `[config error] ${request.url}`,
            ctx
          );
          await dbLogger.logResponse(dbLogId, authError, null, startTime, ctx);
        } catch {
          // Ignore logging failures for config errors
        }
        return authError;
      }
      logger.warn(`Authentication failed for request`);
      // Log auth failure
      try {
        dbLogId = await dbLogger.logRequest(
          request,
          `[auth failed] ${request.url}`,
          ctx
        );
        await dbLogger.logResponse(dbLogId, authError, null, startTime, ctx);
      } catch {
        // Ignore logging failures for auth errors
      }
      return authError;
    }

    // Parse body after auth check
    const data: TradeProcessRequestBody = await request.json();
    incomingRequestId = data?.requestId;

    logger.info(`Processing /process request ID: ${incomingRequestId}`);
    logger.info("Received standardized request", { data });

    // Log the request
    dbLogId = await dbLogger.logRequest(request, data, ctx);

    const payload = data?.payload;
    if (!payload) {
      const response = Errors.badRequest("Missing payload in request");
      await dbLogger.logResponse(dbLogId, response, null, startTime, ctx);
      return response;
    }

    const validation = validateJson(WebhookPayloadSchema, payload);
    if (!validation.ok) {
      const response = Errors.badRequest(validation.error);
      await dbLogger.logResponse(dbLogId, response, null, startTime, ctx);
      return response;
    }

    // *** Use validated payload ***
    const validatedPayload = validation.value;

    // *** Call executeTrade ***
    const tradeResult = await executeTrade(
      validatedPayload,
      env,
      dbLogger,
      startTime,
      dbLogId,
      ctx
    );
    const tradeResponse = createJsonResponse(
      tradeResult,
      tradeResult.status ?? (tradeResult.success ? 200 : 500)
    );

    // Queue R2 report save (if trade was successful) — fire-and-forget
    triggerReportSave(
      tradeResult,
      validatedPayload,
      dbLogId,
      env,
      ctx,
      incomingRequestId
    );

    // Track API call analytics (non-blocking)
    const processLatencyMs = Date.now() - startTime;
    ctx.waitUntil(
      trackAnalytics(env, "/track/api-call", {
        worker: "trade-worker",
        endpoint: "/process",
        latencyMs: processLatencyMs,
        success: tradeResult.success,
      }).catch((err) =>
        logger.error("trackAnalytics failed", { error: String(err) })
      )
    );

    return tradeResponse;
  } catch (error: unknown) {
    return handleError(
      error,
      dbLogger,
      dbLogId,
      startTime,
      request,
      "handleProcessRequest",
      ctx
    );
  }
}
