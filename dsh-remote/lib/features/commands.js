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
import { MAX_TOKEN_REF, TELEGRAM_TOKEN_REF, createRemoteCommands } from "../commands.js";
import { createCredentialAccess, createStore } from "../store.js";
import { createTelegramTransport } from "../transport/telegram.js";
import { RELAY_TOKEN_REF, createRelayTransport } from "../transport/relay.js";
import { createMaxTransport, maxApiBaseFromConfig } from "../transport/max.js";
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
async function ensureTransport(ctx, store, deps, facade, isDisposed = () => false, config = null) {
  const log = (message) => deps.logger.debug(message);
  const binding = store.read().bindings;
  /** 048: явная база MAX из конфига — фолбэк тогда не нужен. */
  const configuredMaxBase = maxApiBaseFromConfig(config);

  // 038: привязка на релей — канал создаём здесь же, чтобы `/remote connect relay`
  // переключал публикацию сразу, а не только после перезагрузки профиля.
  if (binding !== null && binding.transport === "relay") {
    const credentials = createCredentialAccess(ctx, { log });
    const relaySettings = config?.relay !== null && typeof config?.relay === "object" ? config.relay : {};
    const tokenRef = typeof relaySettings.tokenRef === "string" && relaySettings.tokenRef !== "" ? relaySettings.tokenRef : RELAY_TOKEN_REF;
    const token = await credentials.resolve(tokenRef);
    if (isDisposed()) {
      await facade.stop();
      return null;
    }
    if (token === null) {
      deps.logger.warn(`фича commands: привязка на релей, а секрета ${tokenRef} нет — канал не поднят`);
      return null;
    }
    const key = `relay|${binding.url ?? ""}|${token}`;
    const currentRelay = facade.current;
    if (currentRelay !== null && currentRelay.__bindingKey === key) return currentRelay;
    if (currentRelay !== null) await facade.stop();
    let relayTransport;
    try {
      relayTransport = createRelayTransport({
        url: binding.url,
        agentToken: token,
        fetch: relaySettings.fetch,
        wsFactory: relaySettings.wsFactory,
        log: (message) => deps.logger.debug(message),
      });
    } catch (error) {
      deps.logger.warn(`фича commands: транспорт релея не создан (${error?.message ?? error})`);
      return null;
    }
    relayTransport.__bindingKey = key;
    facade.set(relayTransport);
    try {
      await relayTransport.start();
    } catch (error) {
      deps.logger.warn(`фича commands: канал релея не стартовал (${error?.message ?? error})`);
    }
    deps.logger.info("фича commands: канал релея поднят из сохранённой привязки");
    return relayTransport;
  }

  if (binding === null || binding.transport !== "telegram") {
    // Канал из config.telegram (004) мы не создавали — его не гасим: без привязки
    // в состоянии он и есть рабочий канал.
    const adopted = facade.current;
    const boundId = typeof binding?.transport === "string" ? binding.transport : null;
    if (boundId !== null) {
      // 038: привязка на другой транспорт (relay/max) — config-канал не активен.
      if (adopted !== null && adopted.id === boundId) return adopted;
      return null;
    }
    if (adopted !== null && adopted.__bindingKey === undefined) return adopted;
    if (adopted !== null) await facade.stop();
    return null;
  }

  // 039: привязка на MAX — канал создаём здесь же, чтобы `/remote connect MAX`
  // начинал публиковать сразу, без перезагрузки профиля.
  if (binding !== null && binding.transport === "max") {
    const credentials = createCredentialAccess(ctx, { log });
    const maxSettings = config?.max !== null && typeof config?.max === "object" ? config.max : {};
    const tokenRef = typeof maxSettings.tokenRef === "string" && maxSettings.tokenRef !== "" ? maxSettings.tokenRef : MAX_TOKEN_REF;
    const token = await credentials.resolve(tokenRef);
    if (isDisposed()) {
      await facade.stop();
      return null;
    }
    if (token === null) {
      deps.logger.warn(`фича commands: привязка на MAX, а секрета ${tokenRef} нет — канал не поднят`);
      return null;
    }
    const key = `max|${binding.chatId ?? ""}|${binding.userId ?? ""}|${token}`;
    const currentMax = facade.current;
    if (currentMax !== null && currentMax.__bindingKey === key) return currentMax;
    if (currentMax !== null) await facade.stop();
    let maxTransport;
    try {
      maxTransport = createMaxTransport({
        token,
        chatId: binding.chatId ?? null,
        userId: binding.userId ?? null,
        allowedUserIds: binding.userId === null || binding.userId === undefined ? [] : [binding.userId],
        ...(Number.isFinite(binding.marker) ? { marker: binding.marker } : {}),
        persistMarker: (marker) => {
          try {
            store.update((state) => {
              if (state.bindings !== null && state.bindings.transport === "max") state.bindings.marker = marker;
              return state;
            });
          } catch (error) {
            deps.logger.debug(`фича commands: marker MAX не сохранён (${error?.message ?? error})`);
          }
        },
        // 048: явная база (config.maxApiBase главнее config.max.apiBase) отключает
        // фолбэк; не задана — transport сам уйдёт с api2 на platform-api.max.ru по TLS.
        ...(configuredMaxBase === null ? {} : { apiBase: configuredMaxBase }),
        ...(typeof maxSettings.fetch === "function" ? { fetch: maxSettings.fetch } : {}),
        ...(Number.isFinite(maxSettings.pollTimeoutSec) ? { pollTimeoutSec: maxSettings.pollTimeoutSec } : {}),
        log: (message) => deps.logger.debug(message),
      });
    } catch (error) {
      deps.logger.warn(`фича commands: транспорт MAX не создан (${error?.message ?? error})`);
      return null;
    }
    maxTransport.__bindingKey = key;
    facade.set(maxTransport);
    try {
      await maxTransport.start();
    } catch (error) {
      deps.logger.warn(`фича commands: канал MAX не стартовал (${error?.message ?? error})`);
    }
    deps.logger.info("фича commands: канал MAX поднят из сохранённой привязки");
    return maxTransport;
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
    const trace = deps.trace ?? (() => {});
    trace("commands:старт");
    const store = createStore({ log });
    trace("commands:store создан");

    /** Выгрузили ли плагин, пока мы ждали credentials.resolve. */
    let disposed = false;
    deps.onDispose(() => {
      disposed = true;
    });

    // Реестр каналов (012): в него складывают транспорты фичи telegram/max,
    // чтобы ответчик мог публиковать вопрос сразу в несколько.
    const transportRegistry = new Map();
    deps.expose?.("remoteTransports", transportRegistry);
    try {
      ctx.provide?.("remoteTransports", transportRegistry);
    } catch (error) {
      deps.logger.warn(`фича commands: сервис remoteTransports не зарегистрирован (${error?.message ?? error})`);
    }

    // Состояние как сервис: ответчик читает его для реестра режима.
    deps.expose?.(STATE_SERVICE, store);
    try {
      ctx.provide?.(STATE_SERVICE, store);
    } catch (error) {
      deps.logger.warn(`фича commands: сервис ${STATE_SERVICE} не зарегистрирован (${error?.message ?? error})`);
    }

    // Фасад регистрируем всегда: он же управляет каналом из config.telegram (004),
    // который фича telegram положит внутрь (adopt), а connect/disconnect смогут
    // остановить и заменить.
    trace("commands:сервисы provide");
    const existing = ctx?.get?.(TRANSPORT_SERVICE) ?? null;
    const facade = existing?.__isTransportFacade === true ? existing : createTransportFacade();
    /** Чужой транспорт (из config или тестов): его нельзя терять при старте. */
    const foreign = existing !== null && existing !== facade ? existing : null;
    if (foreign !== null) facade.set(foreign);
    deps.expose?.(TRANSPORT_SERVICE, facade);
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
    }, "commands");

    /** Ответчик уже применён (каркасом или нами) — второй раз не подписываем. */
    let answererReady = false;

    /** Стартовый подъём канала: ответчика применит каркас (порядок фич). */
    const ensureAtStart = async () => {
      if (disposed) return null;
      const transport = await ensureTransport(ctx, store, deps, facade, () => disposed, config);
      if (disposed) {
        await facade.stop();
        return null;
      }
      return transport;
    };

    /**
     * Хук для connect: канал поднимаем и фичи, ждавшие `remoteTransport`,
     * поднимаем сразу — иначе `reliability`/`answerer`/`approvals` остались бы
     * пропущенными до перезапуска, и вопрос некуда было бы отправить.
     */
    const ensure = async () => {
      const transport = await ensureAtStart();
      if (transport !== null) transportRegistry.set(transport.id ?? "telegram", transport);
      if (transport !== null && !answererReady) {
        answererReady = true;
        if (typeof deps.retryPending === "function") {
          await deps.retryPending("канал поднят");
        } else {
          // Фолбэк для хостов без каркасного `retryPending` (тесты, старые версии).
          await answererFeature.apply(ctx, config, deps);
        }
      }
      return transport;
    };

    // 012: в мультиканальном режиме фасад пуст, каналы живут в реестре —
    // status/on должны видеть хотя бы один живой канал.
    const currentChannel = () => facade.current ?? [...transportRegistry.values()][0] ?? null;
    trace("commands:createRemoteCommands");
    const configuredMaxBase = maxApiBaseFromConfig(config);
    const remote = createRemoteCommands({
      ctx,
      store,
      log,
      ensureTransport: ensure,
      currentChannel,
      lang: config?.lang ?? null,
      // 039: long polling для pairing MAX; можно переопределить в config.max.
      ...(Number.isFinite(config?.max?.pollTimeoutSec) ? { maxPairingPollTimeoutSec: config.max.pollTimeoutSec } : {}),
      // 048: config.maxApiBase — явная база MAX (фолбэк тогда выключен).
      ...(configuredMaxBase === null ? {} : { maxApiBase: configuredMaxBase }),
    });
    trace("commands:register");
    deps.onDispose(remote.register(), "commands");
    trace("commands:зарегистрирована");

    // Привязка из прошлого запуска: поднимаем канал до того, как каркас дойдёт до
    // фичи ответчика, — её `needs` уже будут выполнены.
    trace("commands:ensureAtStart");
    let transport = await ensureAtStart();
    // Чужой транспорт мог быть снят внутри ensureTransport (например, при
    // отсутствии привязки он решает «канала нет»). Но если он был в контексте —
    // это рабочий канал (config.telegram или тестовый), возвращаем его на место.
    if (facade.current === null && foreign !== null) facade.set(foreign);
    trace(`commands:чужой транспорт ${foreign === null ? "не было" : facade.current === foreign ? "на месте" : "не удержан"}`);
    trace(`commands:ensureAtStart готов (${transport === null ? "канала нет" : transport.id ?? "канал"})`);
    if (transport !== null) answererReady = true;

    // Канал мог не подняться на старте: например, сервис секретов cordis
    // монтируется позже плагина, и `credentials.resolve` вернул null (живой сбой
    // 2026-11-11: после перезапуска бот молчал, хотя привязка была в состоянии).
    // Поэтому пробуем ещё несколько раз с паузой, пока канал не встанет.
    if (transport === null) {
      const delays = [1000, 3000, 7000, 15000];
      let attempt = 0;
      const retry = async () => {
        if (disposed || facade.current !== null) return;
        attempt += 1;
        trace(`commands:повтор подъёма канала #${attempt}`);
        try {
          const started = await ensureAtStart();
          if (started !== null) {
            transportRegistry.set(started.id ?? "telegram", started);
            answererReady = true;
            trace(`commands:канал поднят повтором #${attempt}`);
            return;
          }
        } catch (error) {
          deps.logger.warn(`фича commands: повтор подъёма канала не удался (${error?.message ?? error})`);
        }
        if (attempt < delays.length) {
          const timer = setTimeout(() => void retry(), delays[attempt]);
          timer.unref?.();
          deps.onDispose(() => clearTimeout(timer), "timers");
        }
      };
      const first = setTimeout(() => void retry(), delays[0]);
      first.unref?.();
      deps.onDispose(() => clearTimeout(first), "timers");
    }

    deps.logger.info("фича commands: /remote зарегистрирована");
    // Возвращаем точку подъёма канала: тестам она нужна, чтобы проверить
    // пересоздание транспорта при смене привязки (каркас возврат игнорирует).
    return { ensureTransport: ensure, facade };
  },
};
