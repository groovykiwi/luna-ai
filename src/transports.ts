import type { RuntimeEnvironment } from "./config.js";
import type { RuntimeContext } from "./domain.js";
import { BaileysTransport } from "./baileys.js";
import type { Logger } from "./logging.js";
import { TelegramTransport } from "./telegram.js";
import type { ChatTransport } from "./transport.js";

export interface TransportFactoryOptions {
  telegram?: {
    dropPendingUpdatesOnStart?: boolean;
  };
}

export function createTransport(
  runtimeContext: RuntimeContext,
  environment: RuntimeEnvironment,
  logger: Logger,
  options: TransportFactoryOptions = {}
): ChatTransport {
  if (runtimeContext.botConfig.provider === "telegram") {
    if (!environment.telegramBotToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required for Telegram bots.");
    }

    const telegramOptions =
      options.telegram?.dropPendingUpdatesOnStart === undefined
        ? undefined
        : { dropPendingUpdatesOnStart: options.telegram.dropPendingUpdatesOnStart };

    return new TelegramTransport(environment.telegramBotToken, logger, telegramOptions);
  }

  return new BaileysTransport(runtimeContext.paths.authDir, logger);
}
