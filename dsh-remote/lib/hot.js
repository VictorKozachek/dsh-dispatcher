/**
 * 079: горячая перезагрузка чистых модулей (present/i18n/политика).
 *
 * DSH фиксирует импорты в момент apply(), поэтому правка шапки или текста
 * требовала перезапуска приложения. Здесь — маленький загрузчик с проверкой
 * mtime: модуль импортируется с `?v=<mtimeMs>`, кэш хранит и модуль, и время
 * проверки. Проверка `stat` — не чаще `minCheckMs` (по умолчанию 1 с), рендер
 * вопроса и так не горячий путь.
 *
 * Ошибка импорта не роняет плагин: остаётся предыдущая версия модуля, а в
 * журнал пишется `hot.error`. Явный reload сбрасывает кэш целиком.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} [options]
 * @param {string} [options.libDir] — каталог модулей (по умолчанию lib/).
 * @param {boolean} [options.enabled] — перечитывать ли изменения.
 * @param {number} [options.minCheckMs] — не чаще одной проверки mtime в этот интервал.
 * @param {(url: string) => Promise<any>} [options.importModule]
 * @param {(file: string) => fs.Stats} [options.statSync]
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.log]
 * @param {{record?: Function}|null} [options.journal]
 */
export function createHotLoader({
  libDir = LIB_DIR,
  enabled = true,
  minCheckMs = 1_000,
  importModule = (url) => import(url),
  statSync = fs.statSync,
  now = Date.now,
  log = () => {},
  journal = null,
} = {}) {
  const cache = new Map();
  const clock = () => {
    try {
      return Number(now()) || 0;
    } catch {
      return 0;
    }
  };
  const record = (event, detail) => {
    try {
      journal?.record?.(event, { detail });
    } catch {
      /* журнал не должен ронять загрузчик */
    }
  };
  const resolve = (name) => {
    if (typeof name !== "string" || name === "") throw new TypeError("hot.load: нужно имя модуля");
    return path.isAbsolute(name) ? name : path.resolve(libDir, name);
  };

  async function load(name) {
    const file = resolve(name);
    const cached = cache.get(file);
    const at = clock();
    if (cached !== undefined && enabled && at - cached.checkedAt < minCheckMs) return cached.module;
    let stat;
    try {
      stat = statSync(file);
    } catch (error) {
      if (cached !== undefined) return cached.module;
      throw error;
    }
    const mtimeMs = Number(stat?.mtimeMs) || 0;
    if (cached !== undefined && (!enabled || mtimeMs <= cached.mtimeMs)) {
      cached.checkedAt = at;
      return cached.module;
    }
    try {
      const url = `${pathToFileURL(file).href}?v=${mtimeMs}`;
      const module = await importModule(url);
      cache.set(file, { module, mtimeMs, checkedAt: at });
      if (cached !== undefined) {
        record("hot.reload", { module: path.basename(file), mtimeMs });
      }
      return module;
    } catch (error) {
      const message = String(error?.message ?? error);
      record("hot.error", { module: path.basename(file), message });
      log(`hot: ${path.basename(file)} не перезагружен (${message})`);
      if (cached !== undefined) {
        cached.checkedAt = at;
        return cached.module;
      }
      throw error;
    }
  }

  /** Сбросить кэш: следующий load перечитает файлы с диска. */
  function reload(reason = "manual") {
    cache.clear();
    record("hot.reload", { module: null, reason });
    return true;
  }

  return {
    load,
    reload,
    get enabled() { return enabled; },
    setEnabled(value) { enabled = value === true; },
    get size() { return cache.size; },
    cache,
  };
}

/** Общий загрузчик плагина: его настраивает фича commands и дергает /remote reload. */
let shared = createHotLoader();

export function configureHotReload(enabled, options = {}) {
  shared = createHotLoader({ ...options, enabled: enabled !== false });
  return shared;
}

export function hotLoader() {
  return shared;
}

export function hotLoad(name) {
  return shared.load(name);
}

export function hotReload(reason = "manual") {
  return shared.reload(reason);
}
