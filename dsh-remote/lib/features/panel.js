/**
 * Фича «panel»: host-канал `remotePanel` для таба «Удалённое управление».
 *
 * Панель — клиентская половина (`lib/client.js`), но состояние и журнал лежат
 * вне воркспейса, поэтому снимок для неё собирает хост (см. `lib/panel.js` и
 * `lib/host-channel.js`). Фича не зависит от остальных: если транспорта или
 * reliability в сборке ещё нет, панель покажет статус и журнал, а кнопки
 * честно ответят «недоступно» — это не ошибка загрузки профиля.
 */

import { registerPanelService } from "../host-channel.js";

export const panelFeature = {
  name: "panel",
  needs: [],
  apply(ctx, config, deps) {
    const log = (message) => deps.logger.debug(message);

    /** Живой транспорт канала: у фасада 005 — `current`, иначе сам сервис. */
    const liveTransport = () => {
      const transport = deps.get("remoteTransport");
      if (transport === null) return null;
      return transport.__isTransportFacade === true ? transport.current ?? null : transport;
    };

    const { service, dispose } = registerPanelService(ctx, {
      settings: config ?? {},
      logger: log,
      channelPresent: () => liveTransport() !== null,
      transport: liveTransport,
      reliability: () => deps.get("remoteReliability"),
    });

    deps.onDispose(dispose);
    deps.logger.info("фича panel: host-канал remotePanel зарегистрирован");
    return service;
  },
};
