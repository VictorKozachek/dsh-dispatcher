/**
 * Состояние плагина `dsh-remote` на диске.
 *
 * Файл — `~/.dsh/remote-control/state.json` (переопределяется `DSH_REMOTE_STATE`,
 * это для тестов). Рядом живёт `lock`, он же «один поллер на токен».
 *
 * Правила, ради которых этот модуль существует:
 *   - **атомарная запись**: пишем во временный файл рядом, потом `rename` — при
 *     падении процесса посреди записи state.json не остаётся порванным;
 *   - **chmod 600**: в состоянии лежат chat id, user id и история вопросов;
 *   - **битое состояние не ломает старт**: не разобрался JSON — лог и дефолт,
 *     файл не перезаписываем, чтобы человек мог посмотреть, что случилось;
 *   - **токен не хранится**: единственное, что тут есть про секреты — это имя
 *     ссылки на `ctx.credentials` (`credentialRef`). Сам токен живёт в хранилище
 *     секретов DSH, а не в репозитории, не в профиле и не в state.json.
 *
 * `enabled` намеренно повторяет форму, которую ждёт реестр режима из задачи 002:
 * `{ global, workspaces: { [cwd]: boolean }, sessions: { [id]: boolean } }`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Версия формата состояния: по ней состояние можно будет мигрировать. */
export const STATE_VERSION = 1;

/** Сколько последних вопросов держим в `recent`. */
export const RECENT_LIMIT = 20;

const DEFAULT_FILE_NAME = "state.json";
const LOCK_FILE_NAME = "lock";

/** Куда писать состояние: явный путь из env главнее домашнего каталога. */
export function statePaths({ env = process.env, home = os.homedir() } = {}) {
  const override = typeof env?.DSH_REMOTE_STATE === "string" && env.DSH_REMOTE_STATE !== ""
    ? env.DSH_REMOTE_STATE
    : null;
  const file = override ?? path.join(home, ".dsh", "remote-control", DEFAULT_FILE_NAME);
  const dir = path.dirname(file);
  return { file, dir, lock: path.join(dir, LOCK_FILE_NAME) };
}

/** Состояние по умолчанию: пустая привязка, режим выключен, ничего не ждёт. */
export function defaultState() {
  return {
    version: STATE_VERSION,
    bindings: null,
    enabled: { global: false, workspaces: {}, sessions: {} },
    recent: [],
    pending: [],
  };
}

/** Ссылка на секрет — POSIX-имя переменной окружения (`DSH_REMOTE_TELEGRAM_TOKEN`). */
export function credentialRef(name) {
  if (typeof name !== "string" || name === "") {
    throw new TypeError("credentialRef: нужно непустое имя секрета");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`credentialRef: «${name}» не POSIX-имя (буквы, цифры, _, не с цифры)`);
  }
  return name;
}

/** Доступ к `ctx.credentials`: тонкая обёртка, которая не бросает наружу. */
export function createCredentialAccess(ctx, { log = () => {} } = {}) {
  const service = ctx?.get?.("credentials") ?? null;
  const call = (method, ...args) => {
    try {
      return service?.[method]?.(...args) ?? null;
    } catch (error) {
      log(`credentials.${method}: ${error?.message ?? error}`);
      return null;
    }
  };
  return {
    /** Есть ли сервис вообще: без него токен взять неоткуда. */
    get available() {
      return service !== null && typeof service?.resolve === "function";
    },
    /** Значение секрета или null (не бросает). */
    resolve(ref) {
      const value = call("resolve", ref);
      if (typeof value === "string") return value;
      if (typeof value?.value === "string") return value.value;
      return null;
    },
    /**
     * Откуда берётся секрет: `{ source: "env" | "file" | null, writable, present }`.
     * Окружение главнее файла `~/.dsh/.credentials.yaml`, и в этом случае
     * `writable === false` — `status` обязан это показать, иначе человек правит
     * файл, который никто не читает.
     */
    describe(ref) {
      const value = call("describe", ref);
      if (value === null || typeof value !== "object") {
        return { source: null, writable: false, present: false };
      }
      return {
        source: typeof value.source === "string" ? value.source : null,
        writable: value.writable === true,
        present: value.present === true,
      };
    },
    set(ref, value) {
      return call("set", ref, value) !== null;
    },
    unset(ref) {
      return call("unset", ref) !== null;
    },
  };
}

/**
 * Хранилище состояния.
 *
 * @param {object} [options]
 * @param {string} [options.file] — путь к state.json (иначе из env/homedir).
 * @param {string} [options.home] — домашний каталог (тесты).
 * @param {object} [options.env] — окружение (тесты).
 * @param {() => number} [options.now] — часы.
 * @param {(message: string) => void} [options.log]
 * @param {number} [options.recentLimit]
 */
export function createStore({
  file,
  home,
  env = process.env,
  now = () => Date.now(),
  log = () => {},
  recentLimit = RECENT_LIMIT,
} = {}) {
  const paths = file === undefined ? statePaths({ env, home }) : statePaths({ env: { ...env, DSH_REMOTE_STATE: file }, home });
  let lockOwner = null;

  /** Прочитать состояние: нет файла или битый JSON — дефолт (файл не трогаем). */
  function read() {
    let text;
    try {
      text = fs.readFileSync(paths.file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") log(`состояние: прочитать ${paths.file} не удалось (${error?.message ?? error})`);
      return defaultState();
    }
    try {
      const parsed = JSON.parse(text);
      return normalizeState(parsed, log);
    } catch (error) {
      log(`состояние: битый JSON в ${paths.file} (${error?.message ?? error}) — работаю с дефолтом`);
      return defaultState();
    }
  }

  /** Записать состояние атомарно: tmp → chmod 600 → rename. */
  function write(state) {
    const normalized = normalizeState(state, log);
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(paths.dir, `.${DEFAULT_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
    const payload = `${JSON.stringify(normalized, null, 2)}\n`;
    try {
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, paths.file);
      fs.chmodSync(paths.file, 0o600);
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* уже нет — и хорошо */
      }
      throw error;
    }
    return normalized;
  }

  /** Прочитать → изменить → записать: все мутации идут через это. */
  function update(mutator) {
    const state = read();
    const result = typeof mutator === "function" ? mutator(state) : undefined;
    const next = result === undefined ? state : result;
    return write(next);
  }

  /** Включить/выключить режим для scope: `global`, `workspace` (cwd) или `session`. */
  function setEnabled(scope, value) {
    const enabled = Boolean(value);
    return update((state) => {
      if (scope?.kind === "global") state.enabled.global = enabled;
      else if (scope?.kind === "workspace" && typeof scope.id === "string" && scope.id !== "") {
        state.enabled.workspaces[scope.id] = enabled;
      } else if (scope?.kind === "session" && typeof scope.id === "string" && scope.id !== "") {
        state.enabled.sessions[scope.id] = enabled;
      } else {
        throw new TypeError("setEnabled: неизвестный scope (global | workspace | session)");
      }
      return state;
    });
  }

  /** Привязка бота: транспорт, чат, человек, имя бота. Токена здесь нет и не будет. */
  function setBinding(binding) {
    if (binding === null) {
      return update((state) => {
        state.bindings = null;
        return state;
      });
    }
    const normalized = {
      transport: String(binding?.transport ?? ""),
      chatId: binding?.chatId ?? null,
      userId: binding?.userId ?? null,
      botUsername: binding?.botUsername ?? null,
      createdAt: Number.isFinite(binding?.createdAt) ? binding.createdAt : now(),
    };
    if (normalized.transport === "" || normalized.chatId === null) {
      throw new TypeError("setBinding: нужны transport и chatId");
    }
    return update((state) => {
      state.bindings = normalized;
      return state;
    });
  }

  /** Последние вопросы: кольцевой буфер, старые вытесняются. */
  function addRecent(entry) {
    return update((state) => {
      state.recent.push({ ...entry, at: Number.isFinite(entry?.at) ? entry.at : now() });
      while (state.recent.length > recentLimit) state.recent.shift();
      return state;
    });
  }

  /** Очередь недоставленных вопросов (наполнение — задача 008). */
  function setPending(pending) {
    return update((state) => {
      state.pending = Array.isArray(pending) ? pending : [];
      return state;
    });
  }

  /** Занять lock: `wx` не даёт двум процессам поллить один токен. */
  function acquireLock({ staleAfterMs = 60_000 } = {}) {
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(paths.lock, "wx", 0o600);
        const holder = { pid: process.pid, at: now() };
        fs.writeSync(fd, JSON.stringify(holder));
        fs.closeSync(fd);
        lockOwner = holder;
        return { ok: true, holder };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const holder = readLock();
        if (!isStaleLock(holder, { staleAfterMs })) return { ok: false, holder };
        log(`lock: снимаю устаревший (pid ${holder?.pid ?? "?"}, at ${holder?.at ?? "?"})`);
        try {
          fs.rmSync(paths.lock, { force: true });
        } catch (removeError) {
          log(`lock: устаревший не удалился (${removeError?.message ?? removeError})`);
          return { ok: false, holder };
        }
      }
    }
    return { ok: false, holder: readLock() };
  }

  /** Освободить lock: только свой (чужой не трогаем). */
  function releaseLock() {
    const holder = readLock();
    if (holder !== null && holder.pid !== process.pid) return false;
    try {
      fs.rmSync(paths.lock, { force: true });
    } catch (error) {
      log(`lock: не удалился (${error?.message ?? error})`);
      return false;
    }
    lockOwner = null;
    return true;
  }

  /** Держим ли lock мы или кто-то другой. */
  function lockState() {
    const holder = readLock();
    if (holder === null) return { held: false, holder: null, mine: false };
    return { held: true, holder, mine: holder.pid === process.pid };
  }

  function readLock() {
    try {
      const parsed = JSON.parse(fs.readFileSync(paths.lock, "utf8"));
      return parsed !== null && typeof parsed === "object" ? parsed : {};
    } catch {
      return null;
    }
  }

  function isStaleLock(holder, { staleAfterMs }) {
    if (holder === null) return false;
    if (Number.isFinite(holder.at) && now() - holder.at > staleAfterMs) return true;
    if (Number.isInteger(holder.pid) && holder.pid !== process.pid) {
      try {
        process.kill(holder.pid, 0);
        return false; // процесс жив
      } catch (error) {
        return error?.code === "ESRCH";
      }
    }
    return false;
  }

  return {
    paths,
    read,
    write,
    update,
    setEnabled,
    setBinding,
    addRecent,
    setPending,
    acquireLock,
    releaseLock,
    lockState,
    get recentLimit() {
      return recentLimit;
    },
    /** Что мы держим сами (для тестов и `status`). */
    get lockOwner() {
      return lockOwner;
    },
  };
}

/**
 * Привести состояние к известной форме: чужие/старые поля не теряем, но
 * обязательные — восстанавливаем. Версия пока одна, миграций нет.
 */
function normalizeState(value, log = () => {}) {
  const base = defaultState();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    log("состояние: ожидался объект — работаю с дефолтом");
    return base;
  }
  const version = Number(value.version);
  if (Number.isFinite(version) && version > STATE_VERSION) {
    log(`состояние: версия ${version} новее ${STATE_VERSION} — читаю как есть, незнакомые поля сохраняю`);
  }
  const enabled = value.enabled !== null && typeof value.enabled === "object" ? value.enabled : {};
  return {
    ...base,
    ...value,
    version: STATE_VERSION,
    bindings: value.bindings !== null && typeof value.bindings === "object" ? value.bindings : null,
    enabled: {
      global: enabled.global === true,
      workspaces: booleans(enabled.workspaces),
      sessions: booleans(enabled.sessions),
    },
    recent: Array.isArray(value.recent) ? value.recent.slice(-RECENT_LIMIT) : [],
    pending: Array.isArray(value.pending) ? value.pending : [],
  };
}

/** Оставить только булевы значения (мусор в настройках — не повод падать). */
function booleans(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "boolean") result[key] = item;
  }
  return result;
}
