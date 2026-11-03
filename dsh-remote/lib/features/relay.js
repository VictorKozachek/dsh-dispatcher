/**
 * Фича «relay»: поднять транспорт своего релея (протокол 016/023, сервер 017).
 *
 * Конфиг (`relay` в строке плагина):
 *   { url, tokenRef?, deviceTokenRef?, keyId?, e2e?: { devicePublicKey, privateKeyRef?, alg?, require? } }
 *
 * Токен и приватный ключ e2e берутся только из `ctx.credentials` (ссылки, не
 * значения); по умолчанию — `DSH_REMOTE_RELAY_TOKEN` и
 * `DSH_REMOTE_RELAY_CRYPTO_KEY`. Публичный ключ устройства — не секрет и живёт в
 * конфиге (`e2e.devicePublicKey`, формат `base64:...`). Пока нет url/токена, фича
 * спит: ни сети, ни сервиса.
 *
 * E2E (задача 021): с заполненным `e2e` вопросы шифруются ключом устройства, а
 * ответы расшифровываются; `require: true` запрещает молчаливый откат в открытый
 * режим — без ключей фича не поднимает транспорт.
 *
 * Как и telegram/max, транспорт кладётся в фасад `remoteTransport` (одиночный
 * режим) и всегда — в реестр `remoteTransports`, чтобы ответчик 012 мог выбрать
 * каналы из `config.transports`.
 */

import { createCredentialAccess } from "../store.js";
import { RELAY_TOKEN_REF, createRelayTransport } from "../transport/relay.js";

export const TRANSPORT_SERVICE = "remoteTransport";
export const RELAY_SERVICE = "remoteRelay";

/** Служебное имя секрета с приватным ключом X25519 плагина (задача 021). */
export const RELAY_CRYPTO_KEY_REF = "DSH_REMOTE_RELAY_CRYPTO_KEY";

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
    /**
     * Собрать конфиг e2e из настроек и секретов.
     *
     * @returns {object|null|"fatal"} `null` — открытый режим; `"fatal"` — e2e
     *   обязателен (`require: true`), но ключей нет: транспорт не поднимаем.
     */
    const resolveE2e = async (settings, resolveSecret) => {
      const e2eSettings = settings?.e2e;
      if (e2eSettings === null || typeof e2eSettings !== "object") return null;

      const devicePublicKey = typeof e2eSettings.devicePublicKey === "string"
        ? e2eSettings.devicePublicKey.trim()
        : "";
      const requireE2e = e2eSettings.require === true;
      const privateKeyRef = tokenRefOf(e2eSettings, "privateKeyRef", RELAY_CRYPTO_KEY_REF);
      const privateKey = await resolveSecret(privateKeyRef);
      const missing = [];
      if (devicePublicKey === "") missing.push("devicePublicKey");
      if (privateKey === null) missing.push(`секрет ${privateKeyRef}`);

      if (missing.length > 0) {
        if (requireE2e) {
          deps.logger.warn(`фича relay: e2e обязателен (require: true), но нет ${missing.join(" и ")} — транспорт не поднимаем`);
          return "fatal";
        }
        deps.logger.warn(`фича relay: e2e выключен — нет ${missing.join(" и ")}; тела вопросов пойдут открытым текстом`);
        return null;
      }

      return {
        privateKey,
        devicePublicKey,
        require: requireE2e,
        ...(typeof e2eSettings.alg === "string" && e2eSettings.alg !== "" ? { alg: e2eSettings.alg } : {}),
        ...(typeof e2eSettings.keyId === "string" && e2eSettings.keyId !== "" ? { keyId: e2eSettings.keyId } : {}),
      };
    };

    const agentToken = await resolve(tokenRef);
    const deviceToken = deviceTokenRef === null ? null : await resolve(deviceTokenRef);
    if (disposed) return;
    if (agentToken === null && deviceToken === null) {
      deps.logger.warn(`фича relay: нет токена в ctx.credentials (${tokenRef}) — спит`);
      return;
    }

    const e2e = await resolveE2e(settings, resolve);
    if (e2e === "fatal") return;

    let transport;
    try {
      transport = createRelayTransport({
        url,
        agentToken,
        deviceToken,
        keyId: typeof settings.keyId === "string" && settings.keyId !== "" ? settings.keyId : null,
        e2e,
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
