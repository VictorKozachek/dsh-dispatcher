/**
 * Фича «relay»: поднять транспорт своего релея (протокол 016/023, сервер 017).
 *
 * Конфиг (`relay` в строке плагина):
 *   { url, tokenRef?, deviceTokenRef?, keyId? }
 *
 * Токен берётся только из `ctx.credentials` (ссылка, не значение); по умолчанию —
 * `DSH_REMOTE_RELAY_TOKEN`. Пока нет url/токена, фича спит: ни сети, ни сервиса.
 *
 * Как и telegram/max, транспорт кладётся в фасад `remoteTransport` (одиночный
 * режим) и всегда — в реестр `remoteTransports`, чтобы ответчик 012 мог выбрать
 * каналы из `config.transports`.
 */

import { createCredentialAccess } from "../store.js";
import { RELAY_TOKEN_REF, createRelayTransport } from "../transport/relay.js";

export const TRANSPORT_SERVICE = "remoteTransport";
export const RELAY_SERVICE = "remoteRelay";

function tokenRefOf(settings, key, fallback) {
  const value = settings?.[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}

export const relayFeature = {
  name: "relay",
  needs: [],
  async apply(ctx, config, deps) {
    let disposed = false;
    deps.onDispose(() => {
      disposed = true;
    });

    const settings = config?.relay;
    if (settings === null || typeof settings !== "object") {
      deps.logger.debug("фича relay: не настроена — спит");
      return;
    }
    const url = typeof settings.url === "string" ? settings.url.trim() : "";
    if (url === "") {
      deps.logger.warn("фича relay: нет url — спит");
      return;
    }

    const credentials = createCredentialAccess(ctx, { log: (message) => deps.logger.debug(message) });
    const tokenRef = tokenRefOf(settings, "tokenRef", RELAY_TOKEN_REF);
    const deviceTokenRef = tokenRefOf(settings, "deviceTokenRef", null);
    const resolve = async (ref) => {
      if (ref === null || !credentials.availableFor(ref)) return null;
      try {
        return await credentials.resolve(ref);
      } catch (error) {
        deps.logger.warn(`фича relay: секрет ${ref} не прочитан (${error?.message ?? error})`);
        return null;
      }
    };
    const agentToken = await resolve(tokenRef);
    const deviceToken = deviceTokenRef === null ? null : await resolve(deviceTokenRef);
    if (disposed) return;
    if (agentToken === null && deviceToken === null) {
      deps.logger.warn(`фича relay: нет токена в ctx.credentials (${tokenRef}) — спит`);
      return;
    }

    let transport;
    try {
      transport = createRelayTransport({
        url,
        agentToken,
        deviceToken,
        keyId: typeof settings.keyId === "string" && settings.keyId !== "" ? settings.keyId : null,
        fetch: settings.fetch,
        wsFactory: settings.wsFactory,
        log: (message) => deps.logger.debug(message),
      });
    } catch (error) {
      deps.logger.warn(`фича relay: транспорт не создан (${error?.message ?? error})`);
      return;
    }

    const multiChannel = Array.isArray(config?.transports) && config.transports.length > 1;
    try {
      const facade = ctx?.get?.(TRANSPORT_SERVICE) ?? null;
      if (multiChannel) {
        deps.logger.info("фича relay: мультиканальный режим — транспорт только в реестре");
      } else if (facade !== null && facade.__isTransportFacade === true) {
        facade.set(transport);
      } else {
        ctx.provide?.(TRANSPORT_SERVICE, transport);
      }
    } catch (error) {
      deps.logger.warn(`фича relay: сервис ${TRANSPORT_SERVICE} не зарегистрирован (${error?.message ?? error})`);
    }

    try {
      ctx?.get?.("remoteTransports")?.set?.("relay", transport);
      ctx.provide?.(RELAY_SERVICE, { transport, url });
    } catch (error) {
      deps.logger.debug(`фича relay: реестр/сервис недоступны (${error?.message ?? error})`);
    }

    deps.onDispose(() => {
      void transport.stop();
    });
    void transport.start().catch((error) => {
      deps.logger.warn(`фича relay: старт не удался (${error?.message ?? error})`);
    });
  },
};
