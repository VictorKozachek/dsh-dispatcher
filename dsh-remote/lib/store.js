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

/**
 * Текущая версия схемы `state.json` (задача 032). Растёт только вперёд, ровно
 * на одну ступень за миграцию; каждая ступень — в {@link STATE_MIGRATIONS}.
 */
export const STATE_VERSION = 2;

/**
 * Версия исторических файлов без поля версии (формат 005–031). Такой файл
 * считается v1 и мигрирует вперёд, как любой другой.
 */
export const LEGACY_STATE_VERSION = 1;

/** Сколько последних вопросов держим в `recent`. */
export const RECENT_LIMIT = 20;

/**
 * Отказ из-за схемы состояния: файл новее плагина или миграция невозможна.
 * Сообщение самодостаточно (что случилось + что делать), потому что его
 * показывает и лог, и `/remote doctor`, и текст ошибки команды.
 */
export class StateSchemaError extends Error {
  constructor({ code, message, instruction }) {
    super(instruction === undefined || instruction === "" ? message : `${message} — ${instruction}`);
    this.name = "StateSchemaError";
    this.code = code;
    this.instruction = instruction ?? null;
  }
}

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

/** `basename` проекта: ключ канала в `state.channels` (015). */
function projectKey(name) {
  const raw = typeof name === "string" ? name.trim() : "";
  if (raw === "") return "";
  return raw.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
}

/**
 * Каналы проектов (015): `channels[project][transportId] = {chatId, threadId?}`.
 *
 * Старая плоская форма `channels[project] = {chatId, threadId?}` читается как
 * канал `default` (он применяется к транспорту привязки или когда транспорт не
 * указан) — состояние, записанное прошлой версией, не теряется.
 */
function normalizeChannels(value) {
  const base = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return base;
  for (const [name, entry] of Object.entries(value)) {
    const key = projectKey(name);
    if (key === "") continue;
    if (entry === null || typeof entry !== "object") continue;
    // Плоская запись (или объект с chatId) — канал default.
    const isFlat = entry.chatId !== undefined && entry.chatId !== null && entry.chatId !== "";
    const byTransport = {};
    if (isFlat) {
      byTransport.default = channelOfEntry(entry);
    } else {
      for (const [transportId, channel] of Object.entries(entry)) {
        if (typeof transportId !== "string" || transportId === "") continue;
        if (channel === null || typeof channel !== "object") continue;
        const normalized = channelOfEntry(channel);
        if (normalized !== null) byTransport[transportId] = normalized;
      }
    }
    if (Object.keys(byTransport).length > 0) base[key] = byTransport;
  }
  return base;
}

/** Канал из записи: `{chatId, threadId?}` или `null`, если chatId нет. */
function channelOfEntry(channel) {
  const chatId = channel?.chatId;
  if (chatId === undefined || chatId === null || chatId === "") return null;
  return {
    chatId,
    ...(channel.threadId === undefined || channel.threadId === null || channel.threadId === "" ? {} : { threadId: channel.threadId }),
  };
}

/**
 * Каноническая форма `channels` в v2: `{ project: { transport: {chatId, threadId?} } }`.
 * Плоская запись `{chatId, threadId?}` исторического формата превращается в
 * канал `default` — так же её читал `normalizeChannels` (015), но теперь это
 * ещё и записано на диск миграцией 1 → 2.
 */
function channelsV2(value) {
  const channels = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return channels;
  for (const [name, entry] of Object.entries(value)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const isFlat = Object.prototype.hasOwnProperty.call(entry, "chatId");
    if (isFlat) {
      const channel = channelOfEntry(entry);
      if (channel !== null) channels[name] = { default: channel };
      continue;
    }
    const byTransport = {};
    for (const [transportId, channel] of Object.entries(entry)) {
      if (typeof transportId !== "string" || transportId === "") continue;
      const normalized = channelOfEntry(channel);
      if (normalized !== null) byTransport[transportId] = normalized;
    }
    if (Object.keys(byTransport).length > 0) channels[name] = byTransport;
  }
  return channels;
}

/**
 * Миграция 1 → 2 (задача 032).
 *
 * Меняется только представление `channels`: плоский канал проекта
 * `{chatId, threadId?}` становится `{default: {chatId, threadId?}}`, вложенная
 * форма чистится от лишних полей. Остальные поля сохраняются как есть (включая
 * незнакомые: `...state`), поэтому старый файл не теряет данных.
 */
export function migrateV1ToV2(state) {
  const next = { ...state };
  delete next.version; // историческое поле версии: единственный источник — schemaVersion
  next.schemaVersion = 2;
  next.channels = channelsV2(state?.channels);
  return next;
}

/**
 * Строгий реестр миграций: ключ — исходная версия, значение — функция,
 * возвращающая состояние **следующей** версии. Реестр обязан быть без дырок:
 * `validateMigrationRegistry` проверяет это на каждом чтении.
 */
export const STATE_MIGRATIONS = Object.freeze({
  1: migrateV1ToV2,
});

/** Проверить реестр миграций: каждая ступень 1..STATE_VERSION-1 существует, лишних нет. */
export function validateMigrationRegistry() {
  const problems = [];
  for (let version = LEGACY_STATE_VERSION; version < STATE_VERSION; version += 1) {
    if (typeof STATE_MIGRATIONS[version] !== "function") {
      problems.push(`нет миграции ${version} → ${version + 1}`);
    }
  }
  for (const key of Object.keys(STATE_MIGRATIONS)) {
    const version = Number(key);
    if (!Number.isInteger(version) || version < LEGACY_STATE_VERSION || version > STATE_VERSION) {
      problems.push(`лишняя миграция ${key}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Версия схемы файла: `schemaVersion`, у исторических файлов — `version`,
 * совсем без поля — {@link LEGACY_STATE_VERSION}. Некорректное значение — null.
 */
export function schemaVersionOf(state) {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return null;
  const explicit = state.schemaVersion !== undefined ? state.schemaVersion : state.version;
  if (explicit === undefined || explicit === null) return LEGACY_STATE_VERSION;
  const value = Number(explicit);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * Прогнать состояние по реестру миграций до текущей версии.
 *
 * Чистая функция: файл не трогает, бэкап делает store. Возвращает либо
 * `{state, from, to, applied}`, либо `{error}` — и тогда состояние **нельзя**
 * записывать: файл из будущего/с неполным реестром не перезаписывается.
 */
export function migrateState(raw, { log = () => {} } = {}) {
  const empty = { state: raw, from: null, to: null, applied: [], error: null };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return empty;

  const registry = validateMigrationRegistry();
  if (!registry.ok) {
    const error = {
      code: "missing-migration",
      message: `реестр миграций состояния неполон (${registry.problems.join("; ")})`,
      instruction: "исправьте плагин (STATE_MIGRATIONS в lib/store.js); файл не изменён",
    };
    log(`состояние: ${error.message}`);
    return { ...empty, error };
  }

  const from = schemaVersionOf(raw);
  if (from === null) {
    const error = {
      code: "invalid-version",
      message: "в state.json некорректная версия схемы",
      instruction: "исправьте schemaVersion вручную или восстановите state.json из state.json.bak-*; файл не изменён",
    };
    log(`состояние: ${error.message}`);
    return { ...empty, error };
  }

  if (from > STATE_VERSION) {
    const error = {
      code: "future-version",
      message: `state.json версии ${from} новее плагина (поддерживается ${STATE_VERSION})`,
      instruction: "обновите плагин dsh-remote или восстановите state.json из state.json.bak-*; файл не изменён",
    };
    log(`состояние: ${error.message} — удалённый режим выключен, файл не трогаю`);
    return { ...empty, from, to: from, error };
  }

  let state = raw;
  let version = from;
  const applied = [];
  while (version < STATE_VERSION) {
    const step = STATE_MIGRATIONS[version];
    if (typeof step !== "function") {
      const error = {
        code: "missing-migration",
        message: `нет миграции состояния ${version} → ${version + 1}`,
        instruction: "исправьте плагин (STATE_MIGRATIONS в lib/store.js); файл не изменён",
      };
      log(`состояние: ${error.message}`);
      return { ...empty, from, error };
    }
    try {
      state = step(state);
    } catch (cause) {
      const error = {
        code: "migration-failed",
        message: `миграция состояния ${version} → ${version + 1} не удалась (${cause?.message ?? cause})`,
        instruction: "файл не изменён; восстановите state.json из state.json.bak-* и сообщите об ошибке",
      };
      log(`состояние: ${error.message}`);
      return { ...empty, from, error };
    }
    version += 1;
    state = { ...state, schemaVersion: version };
    applied.push(version);
  }
  return { state, from, to: version, applied, error: null };
}

/**
 * Канал вопроса по воркспейсу и транспорту (015).
 *
 * Порядок: канал проекта для этого транспорта → общий канал проекта
 * (`default`) для транспорта привязки или без транспорта → общий чат привязки
 * (только для транспорта привязки). Чистая функция: тесты гоняют её на объекте
 * состояния.
 *
 * @param {object} state — состояние store.
 * @param {string|null} workspace — cwd сессии/вопроса.
 * @param {string|null} [transportId] — id транспорта (`telegram`, `max`).
 * @returns {{chatId: any, threadId: any, transport: string|null, source: "workspace"|"default"|null}}
 */
export function resolveChannel(state, workspace, transportId = null) {
  const channels = normalizeChannels(state?.channels);
  const name = typeof workspace === "string" && workspace !== ""
    ? workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop()
    : null;
  const project = name === null ? undefined : channels[name];
  const bindingTransport = state?.bindings?.transport ?? null;
  const requested = typeof transportId === "string" && transportId !== "" ? transportId : null;

  if (project !== undefined) {
    if (requested !== null && project[requested] !== undefined) {
      return { chatId: project[requested].chatId, threadId: project[requested].threadId ?? null, transport: requested, source: "workspace" };
    }
    // Без транспорта показываем канал привязки, если он есть у проекта.
    if (requested === null && bindingTransport !== null && project[bindingTransport] !== undefined) {
      return { chatId: project[bindingTransport].chatId, threadId: project[bindingTransport].threadId ?? null, transport: bindingTransport, source: "workspace" };
    }
    // `default` — общий канал проекта: применяем только к транспорту привязки
    // (или когда транспорт не назван), иначе telegram-chatId уедет в MAX.
    if (project.default !== undefined && (requested === null || requested === bindingTransport)) {
      return { chatId: project.default.chatId, threadId: project.default.threadId ?? null, transport: requested ?? bindingTransport, source: "workspace" };
    }
  }

  const fallback = state?.bindings?.chatId;
  if (fallback !== undefined && fallback !== null && fallback !== "" && (requested === null || requested === bindingTransport)) {
    return { chatId: fallback, threadId: null, transport: requested ?? bindingTransport, source: "default" };
  }
  return { chatId: null, threadId: null, transport: requested, source: null };
}

/** Какие транспорты настроены у проекта (для status/list). */
export function channelTransports(state, workspace) {
  const channels = normalizeChannels(state?.channels);
  const name = typeof workspace === "string" && workspace !== ""
    ? workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop()
    : null;
  if (name === null) return {};
  return channels[name] ?? {};
}

/** Состояние по умолчанию: пустая привязка, режим выключен, ничего не ждёт. */
/** Сколько ждём ответа в мессенджере до показа вопроса в GUI (гибрид, 013). */
export const DEFAULT_HYBRID_WAIT_MS = 20_000;

export function defaultState() {
  return {
    schemaVersion: STATE_VERSION,
    bindings: null,
    enabled: { global: false, workspaces: {}, sessions: {} },
    /** Гибридный режим: мессенджер → GUI через `waitMs` (задача 013). */
    hybrid: { enabled: false, waitMs: DEFAULT_HYBRID_WAIT_MS },
    recent: [],
    pending: [],
    /** 014: дедуп уведомлений доски: что уже отправлено и сколько было todo. */
    notify: { seen: [], lastTodo: {}, baseline: {} },
    /** 015: каналы проектов: `{ "<basename cwd>": { chatId, threadId? } }`. */
    channels: {},
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

/**
 * Доступ к `ctx.credentials`: тонкая обёртка, которая не бросает наружу.
 *
 * Настоящий провайдер — `CredentialProvider` (`packages/credentials/credentials/src/index.ts`):
 * **все** методы асинхронные —
 * `resolve(ref) => Promise<{value, source} | undefined>`,
 * `describe(ref) => Promise<{configured, source?, writable}>`,
 * `set(ref, value) => Promise<void>`, `unset(ref) => Promise<void>`.
 * Резолв делается на каждую операцию (кэшировать нельзя — это механизм ротации),
 * а `describe().writable === false` означает «секрет пришёл из окружения»: писать
 * его бессмысленно, и `status` обязан это показать.
 *
 * Если сервиса секретов нет вовсе (урезанный профиль), остаётся **fallback на
 * переменные окружения**: токен можно прочитать, но не записать — и это тоже
 * видно в `status`.
 */
export function createCredentialAccess(ctx, { log = () => {}, env = process.env } = {}) {
  const service = ctx?.get?.("credentials") ?? null;
  const has = (method) => typeof service?.[method] === "function";

  /** Значение из окружения (fallback, только чтение). */
  const fromEnv = (ref) => (typeof env?.[ref] === "string" && env[ref] !== "" ? env[ref] : null);

  /** Вызов сервиса: любой отказ — null и строка в лог, без исключения. */
  async function settle(method, ...args) {
    if (!has(method)) return null;
    try {
      return await service[method](...args);
    } catch (error) {
      log(`credentials.${method}: ${error?.message ?? error}`);
      return null;
    }
  }

  const access = {
    /** Есть ли настоящий провайдер секретов. */
    get available() {
      return has("resolve");
    },
    /** Можно ли получить этот секрет: сервис или переменная окружения. */
    availableFor(ref) {
      return access.available || fromEnv(ref) !== null;
    },
    /** Значение секрета или null (не бросает, принимает строку и `{value}`). */
    async resolve(ref) {
      const value = await settle("resolve", ref);
      if (typeof value === "string") return value;
      if (typeof value?.value === "string") return value.value;
      return fromEnv(ref);
    },
    /** `{source, writable, present}`: откуда секрет и можно ли его записать. */
    async describe(ref) {
      const info = await settle("describe", ref);
      if (info !== null && typeof info === "object") {
        const source = typeof info.source === "string" ? info.source : null;
        return {
          source,
          writable: info.writable === true,
          present: info.configured === true || info.present === true || source !== null,
        };
      }
      return fromEnv(ref) === null
        ? { source: null, writable: false, present: false }
        : { source: "env", writable: false, present: true };
    },
    /** Записать секрет. Успех — отсутствие исключения: сервис возвращает void. */
    async set(ref, value) {
      if (!has("set")) return false;
      try {
        await service.set(ref, value);
        return true;
      } catch (error) {
        log(`credentials.set: ${error?.message ?? error}`);
        return false;
      }
    },
    /** Удалить секрет (не бросает: у env-источника записи нет). */
    async unset(ref) {
      if (!has("unset")) return false;
      try {
        await service.unset(ref);
        return true;
      } catch (error) {
        log(`credentials.unset: ${error?.message ?? error}`);
        return false;
      }
    },
  };
  return access;
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
  /**
   * Отказ схемы (032): файл из будущего/с битой версией или миграция не удалась.
   * Пока он стоит, `read()` отдаёт безопасный дефолт, а `write()` бросает
   * {@link StateSchemaError} — исходный файл не перезаписывается.
   */
  let schemaError = null;
  /** Путь последнего бэкапа перед миграцией (для статуса и тестов). */
  let lastBackup = null;

  /** Что известно про схему: для `/remote doctor` и тестов. */
  function schemaStatus() {
    return {
      ok: schemaError === null,
      version: schemaError === null ? STATE_VERSION : null,
      supported: STATE_VERSION,
      error: schemaError,
      backup: lastBackup,
    };
  }

  /** Записать нормализованное состояние атомарно: tmp → chmod 600 → rename. */
  function writeStateFile(normalized) {
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

  /**
   * Бэкап исходного файла перед миграцией: `state.json.bak-<from>-<ts>`.
   * Копия делается ДО записи мигрированного состояния и содержит байт-в-байт
   * исходный файл, поэтому откат — обычное `cp`.
   */
  function backupBeforeMigration(fromVersion) {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    let target = path.join(paths.dir, `${DEFAULT_FILE_NAME}.bak-${fromVersion}-${stamp}`);
    let suffix = 1;
    while (fs.existsSync(target)) {
      target = path.join(paths.dir, `${DEFAULT_FILE_NAME}.bak-${fromVersion}-${stamp}-${suffix}`);
      suffix += 1;
    }
    fs.copyFileSync(paths.file, target);
    fs.chmodSync(target, 0o600);
    return target;
  }

  /**
   * Прочитать состояние: нет файла или битый JSON — дефолт (файл не трогаем);
   * известная старая версия — миграция вперёд с бэкапом; будущая/битая версия —
   * безопасный дефолт и `schemaError` (запись запрещена).
   */
  function read() {
    let text;
    try {
      text = fs.readFileSync(paths.file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") log(`состояние: прочитать ${paths.file} не удалось (${error?.message ?? error})`);
      schemaError = null;
      return defaultState();
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      log(`состояние: битый JSON в ${paths.file} (${error?.message ?? error}) — работаю с дефолтом`);
      schemaError = null;
      return defaultState();
    }

    const migration = migrateState(parsed, { log });
    if (migration.error !== null) {
      schemaError = migration.error;
      return defaultState();
    }

    if (migration.applied.length > 0) {
      try {
        lastBackup = backupBeforeMigration(migration.from);
        writeStateFile(normalizeState(migration.state, log, recentLimit));
        log(`состояние: миграция схемы ${migration.from} → ${migration.to}, бэкап ${lastBackup}`);
      } catch (error) {
        schemaError = {
          code: "migration-persist-failed",
          message: `не удалось сохранить мигрированное состояние (${error?.message ?? error})`,
          instruction: "проверьте права на каталог состояния и повторите; исходный state.json не тронут",
        };
        log(`состояние: ${schemaError.message} — удалённый режим выключен`);
        return defaultState();
      }
    }

    schemaError = null;
    return normalizeState(migration.state, log, recentLimit);
  }

  /** Записать состояние атомарно. При отказе схемы файл не трогаем. */
  function write(state) {
    if (schemaError !== null) throw new StateSchemaError(schemaError);
    const normalized = normalizeState(state, log, recentLimit);
    return writeStateFile(normalized);
  }

  /** Прочитать → изменить → записать: все мутации идут через это. */
  function update(mutator) {
    const state = read();
    const result = typeof mutator === "function" ? mutator(state) : undefined;
    const next = result === undefined ? state : result;
    return write(next);
  }

  /** Включить/выключить режим для scope: `global`, `workspace` (cwd) или `session`. */
  /**
   * Канал проекта (015): `chatId` (+ `threadId` для топика форума).
   *
   * «Свой/чужой» здесь не проверяем — это делает `/remote channel`; allowlist
   * транспорта всё равно отклонит чат, куда бота не добавляли.
   */
  function setChannel(name, channel, transportId = null) {
    // Имя проекта — basename: `/remote channel /full/path/alpha 100` должен
    // совпадать с resolveChannel, который ищет именно basename(cwd).
    const key = projectKey(name);
    if (key === "") throw new TypeError("setChannel: нужно имя проекта");
    if (channel === null || typeof channel !== "object" || channel.chatId === undefined || channel.chatId === null || channel.chatId === "") {
      throw new TypeError("setChannel: нужен chatId");
    }
    const transport = typeof transportId === "string" && transportId !== ""
      ? transportId
      : (channel.transport ?? read()?.bindings?.transport ?? "default");
    return update((state) => {
      const current = normalizeChannels(state.channels)[key] ?? {};
      state.channels = normalizeChannels({
        ...state.channels,
        [key]: {
          ...current,
          [transport]: {
            chatId: channel.chatId,
            ...(channel.threadId === undefined || channel.threadId === null || channel.threadId === "" ? {} : { threadId: channel.threadId }),
          },
        },
      });
      return state;
    });
  }

  /** Убрать канал проекта: вопросы снова идут в общий чат. */
  function removeChannel(name, transportId = null) {
    // Та же нормализация, что у setChannel: полный путь тоже должен удалять
    // канал проекта, а не создавать «висячий» ключ.
    const key = projectKey(name);
    return update((state) => {
      const channels = normalizeChannels(state.channels);
      if (typeof transportId === "string" && transportId !== "") {
        const project = { ...(channels[key] ?? {}) };
        delete project[transportId];
        if (Object.keys(project).length === 0) delete channels[key];
        else channels[key] = project;
      } else {
        delete channels[key];
      }
      state.channels = normalizeChannels(channels);
      return state;
    });
  }

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

  /**
   * Гибридный режим (013): включить/выключить и при желании поменять ожидание.
   * Поле отдельное от `enabled`: это не scope, а «показать вопрос ещё и в GUI».
   */
  function setHybrid(patch = {}) {
    return update((state) => {
      state.hybrid = {
        enabled: patch.enabled === undefined ? state.hybrid?.enabled === true : patch.enabled === true,
        waitMs: Number.isFinite(patch.waitMs) && patch.waitMs > 0
          ? Math.floor(patch.waitMs)
          : (Number.isFinite(state.hybrid?.waitMs) ? state.hybrid.waitMs : DEFAULT_HYBRID_WAIT_MS),
      };
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

  /**
   * Устарел ли lock.
   *
   * Сначала проверяем живость pid: `connect` держит lock все шаги (до 10 минут
   * pairing), поэтому «старый по времени, но живой» — нормальный lock, а не
   * устаревший. Время решает только когда pid неизвестен или проверить его
   * нельзя.
   */
  function isStaleLock(holder, { staleAfterMs }) {
    if (holder === null) return false;
    if (Number.isInteger(holder.pid)) {
      if (holder.pid === process.pid) return false; // наш собственный lock жив по определению
      try {
        process.kill(holder.pid, 0);
        return false; // процесс жив — lock не трогаем
      } catch (error) {
        if (error?.code === "EPERM") return false; // жив, просто чужой
        if (error?.code === "ESRCH") return true; // мёртв — снимаем
      }
    }
    return Number.isFinite(holder.at) && now() - holder.at > staleAfterMs;
  }

  return {
    paths,
    read,
    write,
    update,
    setEnabled,
    setChannel,
    removeChannel,
    setHybrid,
    setBinding,
    addRecent,
    setPending,
    acquireLock,
    releaseLock,
    lockState,
    /** Статус схемы состояния (032): `{ok, version, supported, error, backup}`. */
    schemaStatus,
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
 * обязательные — восстанавливаем. Версию схемы ставит миграция (032); здесь она
 * только фиксируется в текущей, а историческое поле `version` не сохраняется.
 */
function normalizeState(value, log = () => {}, recentLimit = RECENT_LIMIT) {
  const base = defaultState();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    log("состояние: ожидался объект — работаю с дефолтом");
    return base;
  }
  const { version: legacyVersion, ...rest } = value;
  const enabled = value.enabled !== null && typeof value.enabled === "object" ? value.enabled : {};
  return {
    ...base,
    ...rest,
    schemaVersion: STATE_VERSION,
    bindings: value.bindings !== null && typeof value.bindings === "object" ? value.bindings : null,
    enabled: {
      global: enabled.global === true,
      workspaces: booleans(enabled.workspaces),
      sessions: booleans(enabled.sessions),
    },
    hybrid: {
      enabled: value.hybrid?.enabled === true,
      waitMs: Number.isFinite(value.hybrid?.waitMs) && value.hybrid.waitMs > 0
        ? Math.floor(value.hybrid.waitMs)
        : DEFAULT_HYBRID_WAIT_MS,
    },
    recent: Array.isArray(value.recent) ? value.recent.slice(-Math.max(1, recentLimit)) : [],
    pending: Array.isArray(value.pending) ? value.pending : [],
    notify: {
      seen: Array.isArray(value.notify?.seen) ? value.notify.seen.filter((key) => typeof key === "string").slice(-500) : [],
      lastTodo: value.notify?.lastTodo !== null && typeof value.notify?.lastTodo === "object"
        ? { ...value.notify.lastTodo }
        : {},
      // 014: baseline теперь по воркспейсам (`{project: true}`), старое
      // логическое значение читаем как «все воркспейсы уже базовые».
      baseline: value.notify?.baseline !== null && typeof value.notify?.baseline === "object"
        ? { ...value.notify.baseline }
        : {},
    },
    // 015: ключи каналов — basename; старый/ручной state с путями чинится здесь.
    channels: normalizeChannels(value.channels),
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
