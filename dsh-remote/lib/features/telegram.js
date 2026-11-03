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
import { createCredentialAccess } from "../store.js";

/** Имя сервиса транспорта в контексте плагина. */
/** 015: чаты проектов из состояния — их тоже принимаем (allowlist). */
function projectChatIds(deps) {
  try {
    const state = deps.get("remoteStore")?.read?.() ?? null;
    const channels = state?.channels ?? {};
    return Object.values(channels)
      .map((channel) => channel?.chatId)
      .filter((chatId) => chatId !== undefined && chatId !== null && chatId !== "");
  } catch {
    return [];
  }
}

export const TRANSPORT_SERVICE = "remoteTransport";

/**
 * Токен из хранилища секретов.
 *
 * Настоящий провайдер — `CredentialProvider` с **асинхронным** `resolve(ref)`:
 * `Promise<{value, source} | undefined>` (`packages/credentials/credentials/src/index.ts:183`,
 * `docs/research/dsh-hooks.md` §6.2). Кэшировать нельзя — резолв на каждую
 * операцию и есть механизм ротации. Принимаем и строку, и объект со `value`:
 * фейки в тестах и будущие провайдеры могут отличаться, а токен в конфиге
 * профиля не лежит — там только `tokenRef`.
 */
async function resolveToken(settings, ctx, deps) {
  if (typeof settings.tokenRef !== "string" || settings.tokenRef === "") return null;
  // Общий доступ к секретам (005): ctx.credentials с fallback на окружение.
  const credentials = createCredentialAccess(ctx, { log: (message) => deps.logger.debug(message) });
  if (!credentials.availableFor(settings.tokenRef)) return null;
  return credentials.resolve(settings.tokenRef);
}

export const telegramFeature = {
  name: "telegram",
  needs: [],
  async apply(ctx, config, deps) {
    /** Выгрузили ли плагин, пока мы ждали токен: тогда поллинг не поднимаем. */
    let disposed = false;
    deps.onDispose(() => {
      disposed = true;
    });

    const settings = config?.telegram;
    if (settings === null || typeof settings !== "object") {
      deps.logger.debug("фича telegram: привязки нет — спит (включение в задаче 005)");
      return;
    }

    const token = await resolveToken(settings, ctx, deps);
    if (disposed) {
      deps.logger.debug("фича telegram: плагин выгружен во время чтения токена — не запускаю");
      return;
    }
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
        allowedChatIds: () => projectChatIds(deps),
        pollTimeoutSec: settings.pollTimeoutSec,
        log: (message) => deps.logger.debug(message),
      });
    } catch (error) {
      deps.logger.warn(`фича telegram: транспорт не создан (${error?.message ?? error})`);
      return;
    }

    // 012: при нескольких каналах фасад (005) держит один «current» и гасит
    // previous — второй канал перестал бы принимать ответы. Поэтому в
    // мультиканальном режиме каналы живут сами и регистрируются только в реестре.
    const multiChannel = Array.isArray(config?.transports) && config.transports.length > 1;
    try {
      const facade = ctx?.get?.(TRANSPORT_SERVICE) ?? null;
      if (multiChannel) {
        ctx?.get?.("remoteTransports")?.set?.("telegram", transport);
        deps.logger.info("фича telegram: мультиканальный режим — транспорт только в реестре");
      } else if (facade !== null && facade.__isTransportFacade === true) {
        // Фича commands (005) уже держит фасад: кладём транспорт внутрь, чтобы
        // connect/disconnect могли его заменить и остановить.
        facade.set(transport);
        deps.logger.info("фича telegram: транспорт положен в фасад remoteTransport");
      } else {
        ctx.provide?.(TRANSPORT_SERVICE, transport);
        deps.logger.info("фича telegram: транспорт зарегистрирован как remoteTransport");
      }
    } catch (error) {
      deps.logger.warn(`фича telegram: сервис ${TRANSPORT_SERVICE} не зарегистрирован (${error?.message ?? error})`);
    }

    // Реестр каналов (012): ответчик может публиковать вопрос в несколько.
    try {
      ctx?.get?.("remoteTransports")?.set?.("telegram", transport);
    } catch (error) {
      deps.logger.debug(`фича telegram: реестр каналов недоступен (${error?.message ?? error})`);
    }

    deps.onDispose(() => {
      void transport.stop();
    });

    void transport.start().catch((error) => {
      deps.logger.warn(`фича telegram: поллинг не запустился (${error?.message ?? error})`);
    });
  },
};
