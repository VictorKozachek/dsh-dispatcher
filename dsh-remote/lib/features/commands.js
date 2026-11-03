/**
 * Фича «commands»: регистрирует `/remote` и поднимает канал из привязки.
 *
 * Две обязанности, потому что они про одно и то же — «бот привязан и работает»:
 *   1. `/remote connect|on|off|status|test|who|disconnect` в реестре команд DSH;
 *   2. транспорт из **сохранённой** привязки (`state.json` + `ctx.credentials`).
 *      Фича `telegram` умеет поднимать канал из конфига профиля; здесь — путь без
 *      конфига: человек один раз выполнил `/remote connect`, и после перезапуска
 *      канал поднимается сам. Если привязки нет, ничего не создаётся — вопрос
 *      уходит в GUI, как и раньше.
 *
 * Когда канал поднимается **впервые** (пользователь как раз выполнил connect),
 * ответчик к этому моменту уже пропущен каркасом (у него `needs: [remoteTransport]`,
 * а сервиса не было). Поэтому здесь же поднимается фича ответчика — иначе
 * вопросы продолжали бы уходить в GUI.
 */

import { TELEGRAM_TOKEN_REF, createRemoteCommands } from "../commands.js";
import { createCredentialAccess, createStore } from "../store.js";
import { createTelegramTransport } from "../transport/telegram.js";
import { answererFeature } from "./answerer.js";

/** Имя сервиса транспорта: то же, что ждёт фича answerer в своих `needs`. */
export const TRANSPORT_SERVICE = "remoteTransport";

/**
 * Поднять транспорт из состояния, если привязка есть и канала ещё нет.
 *
 * @returns {Promise<object|null>} транспорт или null, если поднимать нечего.
 */
async function ensureTransport(ctx, store, deps) {
  const existing = ctx?.get?.(TRANSPORT_SERVICE) ?? null;
  if (existing !== null) return existing;

  const binding = store.read().bindings;
  if (binding === null || binding.transport !== "telegram") return null;

  const credentials = createCredentialAccess(ctx, { log: (message) => deps.logger.debug(message) });
  if (!credentials.available) {
    deps.logger.warn("фича commands: привязка есть, но ctx.credentials недоступен — канал не поднят");
    return null;
  }
  const token = await credentials.resolve(TELEGRAM_TOKEN_REF);
  if (token === null) {
    deps.logger.warn(`фича commands: привязка есть, а секрета ${TELEGRAM_TOKEN_REF} нет — канал не поднят`);
    return null;
  }

  let transport;
  try {
    transport = createTelegramTransport({
      token,
      chatId: binding.chatId,
      allowedUserIds: binding.userId === null || binding.userId === undefined ? [] : [binding.userId],
      log: (message) => deps.logger.debug(message),
    });
  } catch (error) {
    deps.logger.warn(`фича commands: транспорт не создан (${error?.message ?? error})`);
    return null;
  }

  try {
    ctx.provide?.(TRANSPORT_SERVICE, transport);
  } catch (error) {
    deps.logger.warn(`фича commands: сервис ${TRANSPORT_SERVICE} не зарегистрирован (${error?.message ?? error})`);
  }
  deps.onDispose(() => {
    void transport.stop();
  });
  await transport.start();
  deps.logger.info("фича commands: канал поднят из сохранённой привязки");
  return transport;
}

export const commandsFeature = {
  name: "commands",
  needs: [],
  async apply(ctx, config, deps) {
    const log = (message) => deps.logger.debug(message);
    const store = createStore({ log });

    const remote = createRemoteCommands({
      ctx,
      store,
      log,
      // `/remote connect` в этой же сессии: транспорт поднимается сразу, а
      // ответчик, пропущенный при старте, подключается здесь же.
      ensureTransport: async () => {
        const hadChannel = (ctx?.get?.(TRANSPORT_SERVICE) ?? null) !== null;
        const transport = await ensureTransport(ctx, store, deps);
        if (!hadChannel && transport !== null) await answererFeature.apply(ctx, config, deps);
        return transport;
      },
    });

    deps.onDispose(remote.register());

    // Привязка из прошлого запуска: канал поднимается до того, как каркас
    // дойдёт до фичи ответчика, — поэтому её `needs` уже выполнены.
    await ensureTransport(ctx, store, deps);

    deps.logger.info("фича commands: /remote зарегистрирована");
  },
};
