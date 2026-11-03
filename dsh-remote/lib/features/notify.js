/**
 * Фича «notify»: человеческие уведомления о событиях доски в канал (014).
 *
 * Наблюдает `.kanban/tasks` перечисленных проектов (только чтение) и шлёт
 * короткие сообщения без кнопок: карточка ушла в `ready`, в `blocked`, в `todo`
 * стало меньше `minTodo`. Наряды агентам рассылает сторож `dsh-kanban` — здесь
 * их нет.
 *
 * Канал берётся из уже поднятого транспорта (фасад 005 или реестр 012); если
 * канала нет, фича спит: отправлять некуда.
 */

import { createNotifier } from "../notify.js";

/** Имя сервиса уведомлений: статистика и ручной scan для команд/панели. */
export const NOTIFIER_SERVICE = "remoteNotifier";

export const notifyFeature = {
  name: "notify",
  needs: [],
  apply(ctx, config, deps) {
    const settings = config?.notify;
    if (settings === null || settings === undefined) return; // фича не настроена
    if (settings === false || settings.enabled === false) {
      deps.logger.debug("фича notify: выключена конфигом");
      return;
    }

    const workspaces = Array.isArray(settings.workspaces)
      ? settings.workspaces.filter((item) => typeof item === "string" && item !== "")
      : [];
    if (workspaces.length === 0) {
      deps.logger.warn("фича notify: не задан список workspaces — уведомлений не будет");
      return;
    }

    /** Живой транспорт: у фасада 005 — current, иначе первый из реестра. */
    const liveTransport = () => {
      const facade = deps.get("remoteTransport");
      if (facade !== null && facade.__isTransportFacade === true) {
        if (facade.current !== null && facade.current !== undefined) return facade.current;
      } else if (facade !== null) {
        return facade;
      }
      const registry = deps.get("remoteTransports");
      if (registry !== null && typeof registry?.values === "function") {
        return [...registry.values()][0] ?? null;
      }
      return null;
    };

    let counter = 0;
    /** Отправка «уведомления»: вопрос без вариантов и без свободного ответа. */
    async function send(message) {
      const transport = liveTransport();
      if (transport === null || typeof transport.sendQuestion !== "function") {
        throw new Error("канал не поднят: /remote connect");
      }
      counter += 1;
      const shortId = `n${String(counter).padStart(7, "0")}`;
      await transport.sendQuestion({
        shortId,
        questionId: `notify-${shortId}`,
        title: "Доска",
        body: message.text,
        options: [],
        multiSelect: false,
        allowFreeText: false,
      });
    }

    // Лимит текста — из возможностей канала: уведомление не должно резаться
    // транспортом где попало.
    const transportCaps = liveTransport()?.caps ?? null;

    const notifier = createNotifier({
      store: deps.get("remoteStore"),
      workspaces,
      send,
      now: () => Date.now(),
      quietHours: settings.quietHours === undefined ? undefined : settings.quietHours,
      enabled: true,
      intervalMs: Number.isFinite(settings.intervalMs) ? settings.intervalMs : undefined,
      maxText: Number.isFinite(transportCaps?.maxText) ? transportCaps.maxText : 4000,
      log: (message) => deps.logger.debug(message),
    });

    try {
      ctx.provide?.(NOTIFIER_SERVICE, notifier);
    } catch (error) {
      deps.logger.warn(`фича notify: сервис ${NOTIFIER_SERVICE} не зарегистрирован (${error?.message ?? error})`);
    }

    notifier.start();
    deps.onDispose(() => notifier.stop());
    deps.logger.info(`фича notify: наблюдаю доски (${workspaces.join(", ")})`);
  },
};
