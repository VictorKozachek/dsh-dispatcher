/**
 * Фича «commands»: регистрирует `/remote` и держит канал из привязки.
 *
 * Три обязанности, потому что они про одно и то же — «бот привязан и работает»:
 *   1. `/remote connect|on|off|status|test|who|disconnect` в реестре команд DSH;
 *   2. **состояние** (`state.json`) как сервис `remoteStore` — его читает ответчик
 *      (002), иначе `/remote on` менял бы файл, а ответчик продолжал видеть «off»;
 *   3. транспорт из сохранённой привязки (`state.json` + `ctx.credentials`).
 *      Фича `telegram` (004) поднимает канал из конфига профиля; здесь — путь без
 *      конфига: `/remote connect` пишет привязку, после перезапуска канал
 *      поднимается сам.
 *
 * Сервис транспорта — **стабильный фасад** (`remoteTransport`): подписка ответчика
 * живёт на фасаде, а `connect`/`disconnect`/смена привязки подменяют внутри него
 * реальный транспорт. Иначе после переподключения ответчик остался бы подписан
 * на старый поллер со старым токеном.
 *
 * Если канал поднимается впервые (человек как раз выполнил `connect`), ответчик к
 * этому моменту уже пропущен каркасом (`needs: [remoteTransport]`, сервиса не
 * было) — поэтому здесь же применяется его фича.
 */

import { DEFAULT_CAPS } from "../transport/base.js";
import { TELEGRAM_TOKEN_REF, createRemoteCommands } from "../commands.js";
import { createCredentialAccess, createStore } from "../store.js";
import { createTelegramTransport } from "../transport/telegram.js";
import { answererFeature } from "./answerer.js";

/** Имя сервиса транспорта: то же, что ждёт фича answerer в своих `needs`. */
export const TRANSPORT_SERVICE = "remoteTransport";

/** Имя сервиса состояния: его читает ответчик для реестра режима. */
export const STATE_SERVICE = "remoteStore";

/**
 * Стабильный фасад транспорта: подписки ответчика не рвутся при переподключении.
 *
 * Пока внутри пусто (`current === null`), методы — no-op: «канал не поднят» не
 * должен ронять ответчик.
 */
function createTransportFacade() {
  let current = null;
  const subscribers = new Set();

  return {
    id: "telegram",
    get caps() {
      return current?.caps ?? DEFAULT_CAPS;
    },
    /** Живой транспорт (для диагностики и тестов). */
    get current() {
      return current;
    },
    set(transport) {
      current = transport;
      for (const handler of subscribers) transport?.onAnswer?.(handler);
    },
    clear() {
      current = null;
    },
    sendQuestion: (question, options) => current?.sendQuestion?.(question, options),
    closeQuestion: (question, summary) => current?.closeQuestion?.(question, summary),
    editQuestion: (question, text) => current?.editQuestion?.(question, text),
    start: () => current?.start?.(),
    async stop() {
      const transport = current;
      current = null;
      await transport?.stop?.();
    },
    healthCheck: () => current?.healthCheck?.() ?? { ok: false, detail: "транспорт не поднят" },
    onAnswer(handler) {
      subscribers.add(handler);
      current?.onAnswer?.(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}

/**
 * Поднять/пересоздать транспорт из состояния.
 *
 * Возвращает живой транспорт или null. Пересоздаёт, если привязка или токен
 * изменились: после `/remote disconnect` + `/remote connect` старый поллер с
 * прежним токеном не должен продолжать работать.
 */
async function ensureTransport(ctx, store, deps, facade, isDisposed = () => false) {
  const log = (message) => deps.logger.debug(message);
  const binding = store.read().bindings;

  if (binding === null || binding.transport !== "telegram") {
    if (facade.current !== null) await facade.stop();
    return null;
  }

  const credentials = createCredentialAccess(ctx, { log });
  const token = await credentials.resolve(TELEGRAM_TOKEN_REF);
  if (isDisposed()) {
    // Плагин выгрузили, пока ждали секрет: поллинг после dispose не поднимаем.
    await facade.stop();
    return null;
  }
  if (token === null) {
    deps.logger.warn(`фича commands: привязка есть, а секрета ${TELEGRAM_TOKEN_REF} нет — канал не поднят`);
    return null;
  }

  const key = `telegram|${binding.chatId}|${binding.userId}`;
  const current = facade.current;
  if (current !== null && current.__bindingKey === key && current.__token === token) return current;
  if (current !== null) {
    deps.logger.info("фича commands: привязка изменилась — пересоздаю транспорт");
    await facade.stop();
  }

  let transport;
  try {
    transport = createTelegramTransport({
      token,
      chatId: binding.chatId,
      allowedUserIds: binding.userId === null || binding.userId === undefined ? [] : [binding.userId],
      log,
    });
  } catch (error) {
    deps.logger.warn(`фича commands: транспорт не создан (${error?.message ?? error})`);
    return null;
  }

  // Снимок привязки для сравнения при следующем connect (токен — только в памяти).
  transport.__bindingKey = key;
  transport.__token = token;
  facade.set(transport);
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

    /** Выгрузили ли плагин, пока мы ждали credentials.resolve. */
    let disposed = false;
    deps.onDispose(() => {
      disposed = true;
    });

    // Состояние как сервис: ответчик читает его для реестра режима.
    try {
      ctx.provide?.(STATE_SERVICE, store);
    } catch (error) {
      deps.logger.warn(`фича commands: сервис ${STATE_SERVICE} не зарегистрирован (${error?.message ?? error})`);
    }

    // Свой фасад — только если канал не поднят конфигом профиля (004).
    let facade = null;
    if ((ctx?.get?.(TRANSPORT_SERVICE) ?? null) === null) {
      facade = createTransportFacade();
      try {
        ctx.provide?.(TRANSPORT_SERVICE, facade);
      } catch (error) {
        facade = null;
        deps.logger.warn(`фича commands: сервис ${TRANSPORT_SERVICE} не зарегистрирован (${error?.message ?? error})`);
      }
    }

    /** Ответчик уже применён (каркасом или нами) — второй раз не подписываем. */
    let answererReady = false;

    const ensure = async () => {
      if (disposed) return null;
      if (facade === null) return ctx?.get?.(TRANSPORT_SERVICE) ?? null;
      const transport = await ensureTransport(ctx, store, deps, facade, () => disposed);
      if (disposed) {
        await facade.stop();
        return null;
      }
      if (transport !== null && !answererReady) {
        answererReady = true;
        await answererFeature.apply(ctx, config, deps);
      }
      return transport;
    };

    const remote = createRemoteCommands({ ctx, store, log, ensureTransport: ensure });
    deps.onDispose(remote.register());

    // Привязка из прошлого запуска: поднимаем канал до того, как каркас дойдёт до
    // фичи ответчика, — её `needs` уже будут выполнены.
    const transport = await ensure();
    if (transport !== null) answererReady = true;

    deps.logger.info("фича commands: /remote зарегистрирована");
    // Возвращаем точку подъёма канала: тестам она нужна, чтобы проверить
    // пересоздание транспорта при смене привязки (каркас возврат игнорирует).
    return { ensureTransport: ensure, facade };
  },
};
