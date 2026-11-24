/**
 * 086: сторож канала. Поднимается после reliability (канал уже есть), до
 * answerer: подписка на onAnswer обновляет «последний апдейт», а периодическая
 * проверка healthCheck ловит тишину и серии ошибок. Перезапуск — через
 * transport.stop/start, с журналом channel.* и видимым status.
 */

import { createChannelWatchdog } from "../channel-watchdog.js";

export const CHANNEL_WATCHDOG_SERVICE = "remoteChannelWatchdog";

export const channelWatchdogFeature = {
  name: "channel-watchdog",
  needs: ["remoteTransport"],
  async apply(ctx, config, deps) {
    const transport = deps.get("remoteTransport");
    if (transport === null || typeof transport.stop !== "function" || typeof transport.start !== "function") {
      deps.logger.debug("фича channel-watchdog: транспорта с stop/start нет — сторож не поднят");
      return;
    }
    const channel = config?.channel ?? {};
    const silenceMinutes = Number.isFinite(channel.silenceMinutes) && channel.silenceMinutes > 0 ? channel.silenceMinutes : 10;
    const errorLimit = Number.isFinite(channel.errorLimit) && channel.errorLimit > 0 ? channel.errorLimit : 5;
    const maxRestarts = Number.isFinite(channel.maxRestarts) && channel.maxRestarts > 0 ? channel.maxRestarts : 3;
    const journal = () => deps.get("remoteJournal") ?? ctx?.get?.("remoteJournal") ?? null;
    const watchdog = createChannelWatchdog({
      transport,
      silenceMs: silenceMinutes * 60_000,
      errorLimit,
      maxRestarts,
      isBusy: () => {
        try {
          const reliability = deps.get("remoteReliability");
          return (reliability?.pendingList?.()?.length ?? 0) > 0;
        } catch {
          return false;
        }
      },
      onEvent: (event) => {
        try {
          journal()?.record?.(event.event, { detail: { ...event } });
        } catch (error) {
          deps.logger.debug(`фича channel-watchdog: журнал не записал ${event.event} (${error?.message ?? error})`);
        }
      },
      log: (message) => deps.logger.debug(message),
    });
    try {
      ctx.provide?.(CHANNEL_WATCHDOG_SERVICE, watchdog);
    } catch (error) {
      deps.logger.warn(`фича channel-watchdog: сервис не зарегистрирован (${error?.message ?? error})`);
    }
    let off = null;
    try {
      off = transport.onAnswer?.(() => watchdog.noteUpdate());
    } catch (error) {
      deps.logger.debug(`фича channel-watchdog: onAnswer не подписал (${error?.message ?? error})`);
    }
    const poll = async () => {
      try {
        const health = await transport.healthCheck?.();
        if (health?.ok === true) watchdog.notePollOk();
        else watchdog.noteError(new Error(health?.detail ?? "healthCheck не прошёл"));
      } catch (error) {
        watchdog.noteError(error);
      }
    };
    const probe = setInterval(() => { void poll(); }, 60_000);
    probe.unref?.();
    deps.onDispose(() => {
      watchdog.stop();
      clearInterval(probe);
      try {
        off?.();
      } catch {
        /* отписка не должна мешать выгрузке */
      }
    }, "channel-watchdog");
    deps.logger.info("фича channel-watchdog: сторож канала подключён");
  },
};
