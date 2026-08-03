/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createLogger } from "@hoox-sh/hoox-shared/middleware";
import { toError } from "@hoox-sh/hoox-shared/errors";
import {
  authenticatedServiceFetch,
  TELEGRAM_ALERT_AUTH_KEY_FIELDS,
  resolveInternalAuthKey,
} from "@hoox-sh/hoox-shared/service-bindings";
import type { TradeQueueMessage } from "@hoox-sh/hoox-shared";

const logger = createLogger({
  service: "trade-worker",
  module: "notifications",
});

export type { TradeQueueMessage };

export interface NotificationsEnv {
  TELEGRAM_SERVICE?: Fetcher;
  TELEGRAM_INTERNAL_KEY_BINDING?: string;
  INTERNAL_KEY_BINDING?: string;
}

// --- Notification Functions ---

/**
 * Sends trade notification to Telegram worker
 * Used by both direct execution and queue processing
 */
export async function sendTradeNotificationToTelegram(
  env: NotificationsEnv,
  result: { success?: boolean; result?: unknown; error?: string },
  routedExchange: string,
  action: string,
  quantity: number,
  symbol: string,
  dbLogId: string | null
): Promise<void> {
  if (!env.TELEGRAM_SERVICE) return;

  try {
    const notificationMessage = result?.success
      ? `Trade executed successfully on ${routedExchange}: ${action} ${quantity} ${symbol}. Result: ${JSON.stringify(result.result)}`
      : `Trade execution failed on ${routedExchange}: ${action} ${quantity} ${symbol}. Error: ${result?.error || "Unknown error"}`;

    const telegramPayload = { message: notificationMessage };
    logger.info("Calling TELEGRAM_SERVICE for notification", { dbLogId });
    if (!resolveInternalAuthKey(env, TELEGRAM_ALERT_AUTH_KEY_FIELDS)) {
      logger.error(
        "Telegram alert auth key not configured — skipping notification (fail-closed)"
      );
      return;
    }
    const notificationResponse = await authenticatedServiceFetch(
      env.TELEGRAM_SERVICE,
      env,
      "/alert",
      telegramPayload,
      { internalKeyFields: TELEGRAM_ALERT_AUTH_KEY_FIELDS }
    );

    if (!notificationResponse.ok) {
      logger.error("Error calling TELEGRAM_SERVICE for notification", {
        dbLogId,
        status: notificationResponse.status,
        responseText: await notificationResponse.text(),
      });
    } else {
      logger.info("Notification sent via TELEGRAM_SERVICE", { dbLogId });
    }
  } catch (notificationError: unknown) {
    const errorMsg = toError(notificationError, "Unknown notification error");
    logger.error("Exception calling TELEGRAM_SERVICE for notification", {
      dbLogId,
      error: errorMsg,
    });
  }
}

/**
 * Sends trade notification for queue-based trades
 * Wrapper around sendTradeNotificationToTelegram for queue message format
 */
export async function sendTradeNotification(
  trade: TradeQueueMessage,
  env: NotificationsEnv,
  result: { success: boolean; error?: string; result?: unknown }
): Promise<void> {
  const exchangeLabel =
    trade.test === true ? `${trade.exchange} [TEST]` : trade.exchange;
  await sendTradeNotificationToTelegram(
    env,
    result,
    exchangeLabel,
    trade.action,
    trade.quantity,
    trade.symbol,
    trade.requestId
  );
}
