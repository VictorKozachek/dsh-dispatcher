/**
 * Фича «журнал» (051): рабочий `log.jsonl` для транспортов/ответчика.
 *
 * Публикует `remoteJournal`; `logFile: false` выключает запись, путь берётся из
 * `config.logFile`, `DSH_REMOTE_LOG_FILE` или `statePaths().log`.
 */

import path from "node:path";

import { createJournal, journalPath } from "../journal.js";

export const JOURNAL_SERVICE = "remoteJournal";

export const journalFeature = {
  name: "journal",
  needs: [],
  apply(ctx, config, deps) {
    // В тестах и на реальном профиле журнал лежит рядом с state.json: берём
    // каталог у store, а не глобальный ~/.dsh (тесты не должны писать в профиль).
    const storeDir = deps.get("remoteStore")?.paths?.dir ?? null;
    const file = typeof config?.logFile === "string" && config.logFile !== ""
      ? config.logFile
      : (typeof process.env.DSH_REMOTE_LOG_FILE === "string" && process.env.DSH_REMOTE_LOG_FILE !== ""
        ? process.env.DSH_REMOTE_LOG_FILE
        : storeDir === null ? journalPath({ config }) : path.join(storeDir, "log.jsonl"));
    const journal = createJournal({
      file,
      enabled: config?.logFile !== false,
      logger: (message) => deps.logger.warn(message),
    });
    // 056: cordis не публикует обычный объект через ctx.provide; общий реестр
    // фич (deps.expose) — основной путь, ctx.provide остаётся для команд/панели.
    deps.expose?.(JOURNAL_SERVICE, journal);
    try {
      ctx.provide?.(JOURNAL_SERVICE, journal);
    } catch (error) {
      deps.logger.warn(`journal: сервис ${JOURNAL_SERVICE} не зарегистрирован (${error?.message ?? error})`);
    }
    deps.logger.debug(`journal: ${journal.enabled ? `пишу в ${file}` : "выключен конфигом"}`);
  },
};
