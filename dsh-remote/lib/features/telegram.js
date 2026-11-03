/**
 * Фича «telegram»: поднять Telegram-транспорт, когда есть привязка.
 *
 * Привязка (токен + chatId) — это состояние `/remote connect`, задача 005.
 * Пока её нет, фича **спит**: ни поллинга, ни сети, ни сервиса в контексте —
 * поведение DSH не меняется. Токен берётся только из `ctx.credentials` (в
 * профиле и в конфиге его нет и быть не должно); `chatId` — из того же состояния.
 *
 * Транспорт регистрируется в контексте как `remoteTransport` — под этим именем
 * его ждут другие фичи (ответчик из задачи 002 объявляет `needs: [remoteTransport]`).
 */

import { createTelegramTransport } from "../transport/telegram.js";

/** Имя сервиса транспорта в контексте плагина. */
export const TRANSPORT_SERVICE = "remoteTransport";

/**
 * Токен из хранилища секретов.
 *
 * `ctx.credentials.get(ref)` может отдать строку или объект со `value` (API
 * уточнит задача 005) — принимаем оба вида. Чего нельзя, так это токена в
 * конфиге профиля: там только `tokenRef`.
 */
function resolveToken(settings, deps) {
  if (typeof settings.tokenRef !== "string" || settings.tokenRef === "") return null;
  const credentials = deps.get("credentials");
  if (credentials === null || typeof credentials?.get !== "function") return null;
  try {
    const value = credentials.get(settings.tokenRef);
    if (typeof value === "string" && value !== "") return value;
    if (typeof value?.value === "string" && value.value !== "") return value.value;
  } catch (error) {
    deps.logger.warn(`фича telegram: токен не прочитан (${error?.message ?? error})`);
  }
  return null;
}

export const telegramFeature = {
  name: "telegram",
  needs: [],
  apply(ctx, config, deps) {
    const settings = config?.telegram;
    if (settings === null || typeof settings !== "object") {
      deps.logger.debug("фича telegram: привязки нет — спит (включение в задаче 005)");
      return;
    }

    const token = resolveToken(settings, deps);
    if (token === null) {
      deps.logger.warn("фича telegram: токена нет в ctx.credentials — спит");
      return;
    }
    if (settings.chatId === undefined || settings.chatId === null || settings.chatId === "") {
      deps.logger.warn("фича telegram: нет chatId привязки — спит");
      return;
    }

    let transport;
    try {
      transport = createTelegramTransport({
        token,
        chatId: settings.chatId,
        allowedUserIds: Array.isArray(settings.allowedUserIds) ? settings.allowedUserIds : [],
        pollTimeoutSec: settings.pollTimeoutSec,
        log: (message) => deps.logger.debug(message),
      });
    } catch (error) {
      deps.logger.warn(`фича telegram: транспорт не создан (${error?.message ?? error})`);
      return;
    }

    try {
      ctx.provide?.(TRANSPORT_SERVICE, transport);
      deps.logger.info("фича telegram: транспорт зарегистрирован как remoteTransport");
    } catch (error) {
      deps.logger.warn(`фича telegram: сервис ${TRANSPORT_SERVICE} не зарегистрирован (${error?.message ?? error})`);
    }

    deps.onDispose(() => {
      void transport.stop();
    });

    void transport.start().catch((error) => {
      deps.logger.warn(`фича telegram: поллинг не запустился (${error?.message ?? error})`);
    });
  },
};
