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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCredentialAccess } from "../store.js";
import { createMaxTransport } from "../transport/max.js";

/** Имя сервиса транспорта в контексте плагина. */
export const TRANSPORT_SERVICE = "remoteTransport";

/** Имя ссылки на токен MAX в `ctx.credentials`. */
export const MAX_TOKEN_REF = "DSH_REMOTE_MAX_TOKEN";

/** Файл с `marker` рядом с состоянием: у MAX нет глобального update_id. */
function markerFile(deps) {
  const store = deps.get("remoteStore");
  const stateFile = typeof store?.paths?.file === "string" && store.paths.file !== ""
    ? store.paths.file
    : (process.env.DSH_REMOTE_STATE || path.join(os.homedir(), ".dsh", "remote-control", "state.json"));
  return path.join(path.dirname(stateFile), "max-marker.json");
}

function readMarker(file, log) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isFinite(parsed?.marker) ? parsed.marker : null;
  } catch (error) {
    if (error?.code !== "ENOENT") log(`фича max: marker не прочитан (${error?.message ?? error})`);
    return null;
  }
}

function writeMarker(file, marker, log) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ marker }), { mode: 0o600 });
  } catch (error) {
    log(`фича max: marker не сохранён (${error?.message ?? error})`);
  }
}

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

    const markerPath = markerFile(deps);
    const log = (message) => deps.logger.debug(message);
    const savedMarker = readMarker(markerPath, log);
    if (savedMarker !== null) deps.logger.info(`фича max: продолжаю с marker ${savedMarker}`);

    let transport;
    try {
      transport = createMaxTransport({
        token,
        chatId: settings.chatId,
        userId: settings.userId,
        allowedUserIds: Array.isArray(settings.allowedUserIds) ? settings.allowedUserIds : [],
        pollTimeoutSec: settings.pollTimeoutSec,
        marker: savedMarker ?? settings.marker,
        persistMarker: (marker) => writeMarker(markerPath, marker, log),
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
