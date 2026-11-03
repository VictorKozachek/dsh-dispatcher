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
import { channelTransports, resolveChannel } from "../store.js";

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
    /** Транспорты из реестра (012) или фасад 005 — по одному на канал. */
    function liveTransports() {
      const registry = deps.get("remoteTransports");
      if (registry !== null && typeof registry?.values === "function") {
        const list = [...registry.values()];
        if (list.length > 0) return list;
      }
      const one = liveTransport();
      return one === null ? [] : [one];
    }

    async function send(message) {
      const all = liveTransports();
      if (all.length === 0) throw new Error("канал не поднят: /remote connect");

      const state = deps.get("remoteStore")?.read?.() ?? {};
      // 015: у проекта может быть свой канал на конкретный транспорт; шлём в
      // те транспорты, для которых он задан, иначе — в первый живой.
      const configured = channelTransports(state, message.workspace ?? null);
      const targets = [];
      for (const [transportId, channel] of Object.entries(configured)) {
        const transport = all.find((item) => item.id === transportId) ?? null;
        if (transport !== null) targets.push({ transport, channel });
      }
      if (targets.length === 0) {
        const transport = all[0];
        targets.push({ transport, channel: resolveChannel(state, message.workspace ?? null, transport.id) });
      }

      for (const { transport, channel } of targets) {
        if (typeof transport.sendQuestion !== "function") continue;
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
        }, {
          ...(channel.chatId === null || channel.chatId === undefined ? {} : { chatId: channel.chatId }),
          ...(channel.threadId === null || channel.threadId === undefined ? {} : { threadId: channel.threadId }),
        });
      }
    }

    const notifier = createNotifier({
      store: deps.get("remoteStore"),
      workspaces,
      send,
      now: () => Date.now(),
      quietHours: settings.quietHours === undefined ? undefined : settings.quietHours,
      enabled: true,
      intervalMs: Number.isFinite(settings.intervalMs) ? settings.intervalMs : undefined,
      // Лимит — в момент отправки: на старте канала обычно ещё нет, а caps
      // появляются/меняются позже.
      resolveMaxText: () => {
        const caps = liveTransport()?.caps ?? null;
        return Number.isFinite(caps?.maxText) ? caps.maxText : 4000;
      },
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
