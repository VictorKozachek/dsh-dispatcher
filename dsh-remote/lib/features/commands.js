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
  /** Отписки подписчиков на текущем транспорте (чтобы снимать их при подмене). */
  const offs = new Map();
  const subscribers = new Set();

  const facade = {
    id: "telegram",
    get caps() {
      return current?.caps ?? DEFAULT_CAPS;
    },
    /** Живой транспорт (для диагностики и тестов). */
    get current() {
      return current;
    },
    /** Маркер для фичи telegram (004): «я — фасад, положи транспорт внутрь». */
    __isTransportFacade: true,
    set(transport) {
      const previous = current;
      // Сначала снимаем подписки со старого транспорта, потом подписываем на новый.
      for (const off of offs.values()) {
        try {
          off?.();
        } catch {
          /* отписка не должна мешать подмене */
        }
      }
      offs.clear();
      current = transport ?? null;
      // Прежний канал (state или config) останавливаем: два поллера одного бота
      // получают 409 и мешают друг другу.
      if (previous !== null && previous !== current) {
        try {
          void previous.stop?.();
        } catch {
          /* остановка не должна мешать подмене */
        }
      }
      for (const handler of subscribers) {
        offs.set(handler, current?.onAnswer?.(handler) ?? null);
      }
    },
    clear() {
      facade.set(null);
    },
    sendQuestion(question, options) {
      if (current === null || typeof current.sendQuestion !== "function") {
        // Не no-op: иначе ответчик решит, что вопрос отправлен, и будет ждать ответ
        // вечно. Ошибка уводит вопрос в GUI через next().
        throw new Error("канал не поднят: /remote connect");
      }
      return current.sendQuestion(question, options);
    },
    closeQuestion(question, summary) {
      return current?.closeQuestion?.(question, summary);
    },
    editQuestion(question, text) {
      return current?.editQuestion?.(question, text);
    },
    start() {
      return current?.start?.() ?? false;
    },
    async stop() {
      const transport = current;
      current = null;
      for (const off of offs.values()) {
        try {
          off?.();
        } catch {
          /* уже отписан */
        }
      }
      offs.clear();
      await transport?.stop?.();
    },
    healthCheck: () => current?.healthCheck?.() ?? { ok: false, detail: "транспорт не поднят" },
    onAnswer(handler) {
      subscribers.add(handler);
      offs.set(handler, current?.onAnswer?.(handler) ?? null);
      return () => {
        subscribers.delete(handler);
        const off = offs.get(handler);
        offs.delete(handler);
        try {
          off?.();
        } catch {
          /* уже отписан */
        }
      };
    },
  };
  return facade;
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
    // Канал из config.telegram (004) мы не создавали — его не гасим: без привязки
    // в состоянии он и есть рабочий канал.
    const adopted = facade.current;
    if (adopted !== null && adopted.__bindingKey === undefined) return adopted;
    if (adopted !== null) await facade.stop();
    return null;
  }

  const credentials = createCredentialAccess(ctx, { log });
  const token = await credentials.resolve(TELEGRAM_TOKEN_REF);
  if (token === null) {
    // Секрет пропал/ротировался: старый канал с прежним токеном поллить не должен.
    await facade.stop();
  }
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

    // Реестр каналов (012): в него складывают транспорты фичи telegram/max,
    // чтобы ответчик мог публиковать вопрос сразу в несколько.
    const transportRegistry = new Map();
    try {
      ctx.provide?.("remoteTransports", transportRegistry);
    } catch (error) {
      deps.logger.warn(`фича commands: сервис remoteTransports не зарегистрирован (${error?.message ?? error})`);
    }

    // Состояние как сервис: ответчик читает его для реестра режима.
    try {
      ctx.provide?.(STATE_SERVICE, store);
    } catch (error) {
      deps.logger.warn(`фича commands: сервис ${STATE_SERVICE} не зарегистрирован (${error?.message ?? error})`);
    }

    // Фасад регистрируем всегда: он же управляет каналом из config.telegram (004),
    // который фича telegram положит внутрь (adopt), а connect/disconnect смогут
    // остановить и заменить.
    const existing = ctx?.get?.(TRANSPORT_SERVICE) ?? null;
    const facade = existing?.__isTransportFacade === true ? existing : createTransportFacade();
    if (existing !== null && existing !== facade) facade.set(existing);
    if (existing === null || existing !== facade) {
      try {
        ctx.provide?.(TRANSPORT_SERVICE, facade);
      } catch (error) {
        deps.logger.warn(`фича commands: сервис ${TRANSPORT_SERVICE} не зарегистрирован (${error?.message ?? error})`);
      }
    }
    // Выгрузка плагина: подписки снимаются, поллинг останавливается.
    deps.onDispose(() => {
      void facade.stop();
    });

    /** Ответчик уже применён (каркасом или нами) — второй раз не подписываем. */
    let answererReady = false;

    /** Стартовый подъём канала: ответчика применит каркас (порядок фич). */
    const ensureAtStart = async () => {
      if (disposed) return null;
      const transport = await ensureTransport(ctx, store, deps, facade, () => disposed);
      if (disposed) {
        await facade.stop();
        return null;
      }
      return transport;
    };

    /** Хук для connect: канал поднимаем и ответчика применяем сразу, если ещё нет. */
    const ensure = async () => {
      const transport = await ensureAtStart();
      if (transport !== null) transportRegistry.set(transport.id ?? "telegram", transport);
      if (transport !== null && !answererReady) {
        answererReady = true;
        await answererFeature.apply(ctx, config, deps);
      }
      return transport;
    };

    const currentChannel = () => facade.current;
    const remote = createRemoteCommands({ ctx, store, log, ensureTransport: ensure, currentChannel });
    deps.onDispose(remote.register());

    // Привязка из прошлого запуска: поднимаем канал до того, как каркас дойдёт до
    // фичи ответчика, — её `needs` уже будут выполнены.
    const transport = await ensureAtStart();
    if (transport !== null) answererReady = true;

    deps.logger.info("фича commands: /remote зарегистрирована");
    // Возвращаем точку подъёма канала: тестам она нужна, чтобы проверить
    // пересоздание транспорта при смене привязки (каркас возврат игнорирует).
    return { ensureTransport: ensure, facade };
  },
};
