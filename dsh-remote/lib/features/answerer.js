/**
 * Фича «ответчик»: вопрос человека уходит в транспорт мессенджера.
 *
 * Подключается к каркасу одной строкой в `lib/features.js`. Транспорта пока нет
 * (его объявит задача 003), поэтому фича заявляет его в `needs`: каркас пропустит
 * её с предупреждением, и вопрос спокойно уйдёт в GUI — поведение DSH не меняется.
 *
 * Состояние режима (`~/.dsh/remote-control/state.json`) появится в задаче 005;
 * пока источник пустой, значит режим выключен, и это тот же безопасный путь.
 */

import { createAnswerer } from "../answerer.js";
import { resolveChannel } from "../store.js";
import { createRegistry } from "../domain/registry.js";

/** Имя сервиса транспорта: его объявит задача 003 (`dsh-remote/lib/transport`). */
export const TRANSPORT_SERVICE = "remoteTransport";

/** Имя сервиса состояния: его объявляет фича commands (005). */
export const STATE_SERVICE = "remoteStore";

/**
 * Динамический транспорт ответчика (038): активный канал выбирается НА КАЖДОЙ
 * отправке из `state.bindings.transport` + реестра, а не кэшируется в apply.
 * Иначе после `/remote connect` ответчик оставался бы на прежнем канале.
 *
 * Подписки на ответы собираются со всех известных каналов (фасад + реестр):
 * фасад сам переподписывает подписчиков при `set()`, а каналы, появившиеся позже
 * (relay после live-connect), подхватываются в `sync()` перед отправкой.
 */
function createBindingTransport({ facade, registry, store, log = () => {} }) {
  const subscribers = new Set();
  const subscriptions = new Map();
  const bindingId = () => {
    try {
      const binding = store?.read?.().bindings ?? null;
      return typeof binding?.transport === "string" && binding.transport !== "" ? binding.transport : null;
    } catch {
      return null;
    }
  };
  const active = () => {
    const id = bindingId();
    if (id !== null) {
      const bound = registry?.get?.(id) ?? null;
      if (bound !== null) return bound;
    }
    return facade ?? null;
  };
  const sync = () => {
    const candidates = new Set([facade]);
    try {
      for (const channel of registry?.values?.() ?? []) candidates.add(channel);
    } catch {
      /* реестр недоступен */
    }
    for (const channel of candidates) {
      if (channel === null || channel === undefined || subscriptions.has(channel)) continue;
      if (typeof channel.onAnswer !== "function") continue;
      let off = null;
      try {
        off = channel.onAnswer((event) => {
          for (const handler of [...subscribers]) handler(event);
        });
      } catch (error) {
        log(`answerer: подписка на канал ${channel.id ?? "?"} не удалась (${error?.message ?? error})`);
      }
      subscriptions.set(channel, off);
    }
  };

  return {
    get id() {
      return active()?.id ?? "binding";
    },
    get caps() {
      return active()?.caps ?? facade?.caps ?? {};
    },
    async start() {
      sync();
      return active()?.start?.() ?? false;
    },
    async stop() {
      return active()?.stop?.();
    },
    sendQuestion(question, options) {
      sync();
      const channel = active();
      if (channel === null || typeof channel.sendQuestion !== "function") {
        throw new Error("канал не поднят: /remote connect");
      }
      return channel.sendQuestion(question, options);
    },
    closeQuestion(question, summary) {
      return active()?.closeQuestion?.(question, summary);
    },
    editQuestion(question, text) {
      return active()?.editQuestion?.(question, text);
    },
    healthCheck() {
      return active()?.healthCheck?.() ?? { ok: false, detail: "канал не поднят" };
    },
    onAnswer(handler) {
      subscribers.add(handler);
      sync();
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}

export const answererFeature = {
  name: "answerer",
  needs: [TRANSPORT_SERVICE],
  apply(ctx, config, deps) {
    // Состояние — сервис `remoteStore` (005). Без него режим считаем выключенным:
    // лучше отдать вопрос в GUI, чем увести его в мессенджер «на всякий случай».
    const store = deps.get(STATE_SERVICE);
    const registry = createRegistry({
      readState: () => {
        try {
          const state = typeof store?.read === "function" ? store.read() : null;
          return state?.enabled ?? {};
        } catch (error) {
          deps.logger.warn(`answerer: состояние не прочитано (${error?.message ?? error})`);
          return {};
        }
      },
      log: (message) => deps.logger.debug(message),
    });

    // Устойчивость (008): доставка с повторами и TTL-сторож живут в отдельной
    // фиче; здесь только передаём их ответчику.
    const reliability = deps.get("remoteReliability");

    // Два канала одновременно (012): список из config.transports, транспорты
    // берём из реестра. Один канал — прежний путь через фасад.
    const requested = Array.isArray(config?.transports) ? config.transports.filter((id) => typeof id === "string") : null;
    const transportRegistry = deps.get("remoteTransports");
    let transports = null;
    if (requested !== null && requested.length > 1 && transportRegistry !== null) {
      const missing = requested.filter((id) => transportRegistry.get(id) === undefined);
      if (missing.length > 0) {
        // Не молчим: иначе два канала в конфиге тихо превратятся в один.
        deps.logger.warn(`answerer: каналы из config.transports не найдены: ${missing.join(", ")} — работаю с тем, что есть`);
      }
      transports = requested.map((id) => transportRegistry.get(id) ?? null).filter((transport) => transport !== null);
      if (transports.length <= 1) transports = null;
    }

    // 038: в обычном режиме публикуем в АКТИВНЫЙ канал из `state.bindings`, а не
    // в «последний поднятый» фасад: иначе relay-конфиг, смонтированный позже
    // telegram, перетирал бы фасад и вопросы уходили бы не туда.
    const bindingTransportId = (() => {
      try {
        const binding = store?.read?.().bindings ?? null;
        return typeof binding?.transport === "string" && binding.transport !== "" ? binding.transport : null;
      } catch {
        return null;
      }
    })();
    const serviceTransport = deps.get(TRANSPORT_SERVICE);
    // В обычном режиме — динамический транспорт по привязке: `/remote connect`
    // может сменить канал уже после apply, и ответчик обязан это увидеть.
    const activeTransport = transports === null
      ? createBindingTransport({
        facade: serviceTransport,
        registry: transportRegistry,
        store,
        log: (message) => deps.logger.debug(message),
      })
      : serviceTransport;
    if (bindingTransportId !== null) {
      deps.logger.debug(`answerer: активный канал из привязки — ${bindingTransportId} (динамически)`);
    }

    // 012: у каждого канала — своя доставка reliability (повторы/backoff/give-up).
    const deliverFor = deps.get("remoteReliabilityDeliver");
    // Гибрид (013): ждём ответ в мессенджере `hybrid.waitMs`, потом отдаём в GUI.
    const answerer = createAnswerer({
      transport: activeTransport,
      deliverFor,
      // 015: канал проекта — свой чат/топик, иначе общий чат привязки.
      channelOf: (workspace, transportId) => resolveChannel(store?.read?.() ?? {}, workspace, transportId),
      transports,
      hybrid: () => (store?.read?.().hybrid ?? { enabled: false }),
      registry,
      reliability,
      metrics: deps.get("remoteMetrics") ?? null,
      deliver: reliability === null ? null : (argument) => reliability.deliver(argument),
      log: (message) => deps.logger.debug(message),
    });

    deps.onDispose(answerer.attach(ctx), "closers");
    // Метрика гибрида доступна командам (`/remote status`) как сервис.
    try {
      ctx.provide?.("remoteAnswerer", { stats: answerer.stats });
    } catch (error) {
      deps.logger.debug(`answerer: сервис статистики не зарегистрирован (${error?.message ?? error})`);
    }
    // Метрика режима видна в логе при выгрузке: сколько ушло в GUI и сколько
    // потом ответили из телефона.
    deps.onDispose(() => {
      const stats = answerer.stats ?? {};
      if (stats.hybridHanded > 0 || stats.hybridPhoneAnswers > 0) {
        deps.logger.info(`гибрид: в GUI отдано ${stats.hybridHanded}, ответов из мессенджера после GUI ${stats.hybridPhoneAnswers}`);
      }
    });
  },
};
