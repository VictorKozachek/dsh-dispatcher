/**
 * Фича «reliability»: очередь/ретраи доставки, TTL-сторож, рестарт и журнал.
 *
 * Подключается одной строкой в `lib/features.js` **до** answerer: ответчик берёт
 * отсюда `deliver` (повторы и `give-up` → `next()`) и ставит открытые вопросы под
 * TTL-сторож.
 *
 * Состояние и журнал живут вне репозитория (`~/.dsh/remote-control/`). Если
 * фича commands (005) зарегистрировала сервис `remoteStore`, используем его —
 * тогда состояние общее с `/remote on|off`; иначе reliability заводит свой файл
 * (путь по умолчанию или `DSH_REMOTE_STATE`).
 */

import { createReliability, defaultPaths } from "../reliability.js";

/** Имя сервиса устойчивости: его читает фича answerer. */
export const RELIABILITY_SERVICE = "remoteReliability";

export const reliabilityFeature = {
  name: "reliability",
  needs: ["remoteTransport"],
  async apply(ctx, config, deps) {
    const log = (message) => deps.logger.debug(message);
    const paths = defaultPaths();
    const store = deps.get("remoteStore") ?? null;

    const reliability = createReliability({
      transport: deps.get("remoteTransport"),
      // 012: TTL/напоминания/recover идут во все каналы вопроса, которые
      // находятся по id в реестре (в мультиканальном режиме фасад пуст).
      transportFor: (transportId) => deps.get("remoteTransports")?.get?.(transportId) ?? null,
      state: store,
      ...(store === null ? { stateFile: paths.state } : {}),
      logFile: typeof config?.logFile === "string" ? config.logFile : paths.log,
      sessionController: ctx?.get?.("sessionController") ?? deps.get("sessionController") ?? null,
      onExpire: config?.onExpire,
      redactMode: config?.redactMode,
      // 034: после рестарта вопрос мёртвой сессии снимаем сразу (а не ждём).
      isSessionAlive: (sessionId) => {
        try {
          const sessions = typeof ctx?.get === "function" ? ctx.get("sessions") : null;
          return typeof sessions?.get === "function" ? sessions.get(sessionId) != null : null;
        } catch {
          return null;
        }
      },
      metrics: deps.get("remoteMetrics") ?? null,
      log,
    });

    try {
      ctx.provide?.(RELIABILITY_SERVICE, reliability);
      // 012: доставка в конкретный канал с повторами/таймаутом/сигналом 008.
      ctx.provide?.("remoteReliabilityDeliver", (targetTransport) => async (argument) => {
        const outcome = await reliability.deliver({ ...argument, transport: targetTransport });
        if (outcome !== "delivered") return outcome;
        // Брокеру 012 нужен messageId, чтобы recover после рестарта мог править
        // сообщения: `deliver` отдаёт строку, поэтому достаём id из состояния.
        const info = reliability.deliveryInfo?.(argument?.question?.shortId, targetTransport?.id) ?? null;
        return {
          delivered: true,
          messageId: info?.messageId ?? null,
          chatId: info?.chatId ?? targetTransport?.chatId ?? null,
        };
      });
    } catch (error) {
      deps.logger.warn(`фича reliability: сервис ${RELIABILITY_SERVICE} не зарегистрирован (${error?.message ?? error})`);
    }

    // Рестарт: «осиротевшие» вопросы снимаем до того, как поднимется сторож.
    try {
      const recovered = await reliability.recoverOrphans();
      if (recovered.cancelled > 0 || recovered.failed > 0) {
        deps.logger.info(`фича reliability: после рестарта снято ${recovered.cancelled}, ошибок ${recovered.failed}`);
      }
    } catch (error) {
      deps.logger.warn(`фича reliability: recoverOrphans упал (${error?.message ?? error})`);
    }

    reliability.start();
    deps.onDispose(() => reliability.stop(), "timers");
    deps.logger.info("фича reliability: сторож и доставка подключены");
  },
};
