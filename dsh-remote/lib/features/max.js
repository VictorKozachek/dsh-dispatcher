/**
 * Фича «max»: поднять MAX-транспорт, когда есть привязка.
 *
 * Повторяет логику фичи telegram (004/005): пока токена/чата нет — спит, ничего
 * не поллит. Токен — только через `ctx.credentials` (`DSH_REMOTE_MAX_TOKEN`),
 * чат/пользователь — из `config.max` (или состояния `/remote connect`, когда
 * MAX появится в коннекте).
 *
 * Режим webhook: MAX требует публичный HTTPS:443 с валидным сертификатом, а DSH
 * не умеет слушать внешний адрес, поэтому при `webhookUrl` фича **не запускает**
 * транспорт и пишет внятную ошибку в лог (карточка 011) — «молчания» не будет.
 */

import { createCredentialAccess } from "../store.js";
import { createMaxTransport } from "../transport/max.js";

/** Имя сервиса транспорта в контексте плагина. */
export const TRANSPORT_SERVICE = "remoteTransport";

/** Имя ссылки на токен MAX в `ctx.credentials`. */
export const MAX_TOKEN_REF = "DSH_REMOTE_MAX_TOKEN";

export const maxFeature = {
  name: "max",
  needs: [],
  async apply(ctx, config, deps) {
    let disposed = false;
    deps.onDispose(() => {
      disposed = true;
    });

    const settings = config?.max;
    if (settings === null || typeof settings !== "object") {
      deps.logger.debug("фича max: привязки нет — спит");
      return;
    }
    if (typeof settings.webhookUrl === "string" && settings.webhookUrl !== "") {
      deps.logger.error(
        "фича max: режим webhook недоступен — нужен публичный HTTPS:443 с валидным сертификатом, "
        + "а DSH не умеет слушать внешний адрес; используйте long polling (GET /updates) или туннель",
      );
      return;
    }

    const credentials = createCredentialAccess(ctx, { log: (message) => deps.logger.debug(message) });
    const tokenRef = typeof settings.tokenRef === "string" && settings.tokenRef !== "" ? settings.tokenRef : MAX_TOKEN_REF;
    if (!credentials.availableFor(tokenRef)) {
      deps.logger.warn(`фича max: токена ${tokenRef} нет в ctx.credentials — спит`);
      return;
    }
    const token = await credentials.resolve(tokenRef);
    if (disposed) return;
    if (typeof token !== "string" || token === "") {
      deps.logger.warn(`фича max: токен ${tokenRef} не разрешился — спит`);
      return;
    }

    let transport;
    try {
      transport = createMaxTransport({
        token,
        chatId: settings.chatId,
        userId: settings.userId,
        allowedUserIds: Array.isArray(settings.allowedUserIds) ? settings.allowedUserIds : [],
        pollTimeoutSec: settings.pollTimeoutSec,
        marker: settings.marker,
        persistMarker: (marker) => {
          if (typeof deps.setMarker === "function") deps.setMarker(marker);
          else deps.logger.debug(`фича max: marker ${marker} (не сохранён — нет хранилища)`);
        },
        log: (message) => deps.logger.debug(message),
      });
    } catch (error) {
      deps.logger.warn(`фича max: транспорт не создан (${error?.message ?? error})`);
      return;
    }

    try {
      const facade = ctx?.get?.(TRANSPORT_SERVICE) ?? null;
      if (facade !== null && facade.__isTransportFacade === true) {
        facade.set(transport);
        deps.logger.info("фича max: транспорт положен в фасад remoteTransport");
      } else {
        ctx.provide?.(TRANSPORT_SERVICE, transport);
        deps.logger.info("фича max: транспорт зарегистрирован как remoteTransport");
      }
    } catch (error) {
      deps.logger.warn(`фича max: сервис ${TRANSPORT_SERVICE} не зарегистрирован (${error?.message ?? error})`);
    }

    deps.onDispose(() => {
      void transport.stop();
    });

    void transport.start().catch((error) => {
      deps.logger.warn(`фича max: поллинг не запустился (${error?.message ?? error})`);
    });
  },
};
