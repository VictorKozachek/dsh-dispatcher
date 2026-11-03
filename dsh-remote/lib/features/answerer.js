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

    // 012: у каждого канала — своя доставка reliability (повторы/backoff/give-up).
    const deliverFor = deps.get("remoteReliabilityDeliver");
    // Гибрид (013): ждём ответ в мессенджере `hybrid.waitMs`, потом отдаём в GUI.
    const answerer = createAnswerer({
      transport: deps.get(TRANSPORT_SERVICE),
      deliverFor,
      // 015: канал проекта — свой чат/топик, иначе общий чат привязки.
      channelOf: (workspace, transportId) => resolveChannel(store?.read?.() ?? {}, workspace, transportId),
      transports,
      hybrid: () => (store?.read?.().hybrid ?? { enabled: false }),
      registry,
      reliability,
      deliver: reliability === null ? null : (argument) => reliability.deliver(argument),
      log: (message) => deps.logger.debug(message),
    });

    deps.onDispose(answerer.attach(ctx));
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
