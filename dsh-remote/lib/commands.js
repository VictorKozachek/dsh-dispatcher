/**
 * Команды `/remote`: подключение бота и включение удалённого режима.
 *
 * Это вход в систему: пока бот не привязан, плагин спит (фича telegram ждёт
 * привязку), и вопрос человека рисует GUI, как обычно. `/remote connect` доводит
 * человека до привязки по шагам через **локальные** вопросы (`ctx.userQuestions`),
 * потому что удалённый режим в этот момент ещё выключен.
 *
 * Правила, которые здесь закреплены:
 *   - **токен не печатается и не пишется на диск**: он уходит только в
 *     `ctx.credentials` под POSIX-именем `DSH_REMOTE_TELEGRAM_TOKEN`, а в
 *     `status`/логах видны лишь имя ссылки и источник (`env`/`file`);
 *   - **без подтверждённого pairing-кода привязки нет**: код живёт 10 минут,
 *     ждём сообщение с ним боту, а иначе — понятный отказ;
 *   - **состояние — файл** (`store.js`): привязка, режим по scope, история;
 *   - **ошибка команды — текст человеку**, а не stacktrace: всё, что бросает
 *     транспорт или хранилище, превращается в `{kind:'error', text}`;
 *   - **один поллер на токен**: на время pairing берём lock-файл состояния.
 *
 * Режим (`on`/`off`) по умолчанию меняется для воркспейса текущей сессии
 * (`cwd`), `--all` — глобально, `--session` — только для этой сессии. Приоритет
 * при чтении — как в реестре задачи 002: сессия → воркспейс → глобально.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRegistry } from "./domain/registry.js";
import { STATE_VERSION, credentialRef, createCredentialAccess } from "./store.js";
import {
  buildReport,
  formatHealthReport,
  runHealthChecks,
  serializeReport,
} from "./doctor.js";
import { RELAY_TOKEN_REF } from "./transport/relay.js";
import {
  MAX_PAIRING_POLL_TIMEOUT_SEC,
  maxHostOf,
  maxMe,
  maxPollForCode,
} from "./transport/max.js";
import { createAudit } from "./audit.js";
import { DEFAULT_KEEP, vacuum } from "./rotate.js";
import { formatStats } from "./metrics.js";
import { DEFAULT_LANG, LANGS, normalizeLang, resolveLanguage, t } from "./i18n.js";

/** Язык текущего вызова команд: `t()` для строк, вынесенных в словарь (049). */
let commandLang = DEFAULT_LANG;

/** Перевод строки вывода команд на язык текущего вызова. */
function tx(key, params = {}) {
  return t(key, params, commandLang);
}
import { randomUUID } from "node:crypto";

/**
 * Сервис из контекста БЕЗ прямого обращения к свойству.
 *
 * cordis отвечает `cannot get property "<name>" without inject`, если читать
 * `ctx.<service>` у сервиса, которого нет в `inject` плагина. Наш плагин
 * сознательно ничего не требует жёстко (`inject: []`): недостающий сервис — это
 * деградация, а не отказ. Поэтому все сервисы берутся через `ctx.get(name)`:
 * он возвращает `null`, а не бросает.
 *
 * @param {object} ctx - контекст cordis (или фейковый в тестах)
 * @param {string} name - имя сервиса
 * @returns {object|null} сервис или null
 */
export function serviceOf(ctx, name) {
  // 1) cordis-путь: `ctx.get(name)` возвращает сервис или null и не бросает.
  try {
    const viaGet = ctx?.get?.(name);
    if (viaGet !== null && viaGet !== undefined) return viaGet;
  } catch {
    /* ctx без get или бросающий get — идём дальше */
  }
  // 2) прямой доступ: так сервисы подставляют тесты и простые хосты. В cordis
  //    это бросит `without inject` — именно поэтому доступ обёрнут.
  try {
    return ctx?.[name] ?? null;
  } catch {
    return null;
  }
}

/** Имя ссылки на токен Telegram в `ctx.credentials` (не значение!). */
export const TELEGRAM_TOKEN_REF = credentialRef("DSH_REMOTE_TELEGRAM_TOKEN");

/** Имя ссылки на токен MAX (038/039): тот же секрет, что читает фича max. */
export const MAX_TOKEN_REF = credentialRef("DSH_REMOTE_MAX_TOKEN");

/** Человеческое имя транспорта для ответов connect/status. */
export function transportLabel(transport) {
  if (transport === "telegram") return "Telegram";
  if (transport === "max") return "MAX";
  if (transport === "relay") return tx("commands.transportLabel.1");
  return typeof transport === "string" && transport !== "" ? transport : tx("commands.transportLabel.2");
}

/** Ссылка на секрет транспорта: при переключении канала чистим именно её. */
export function tokenRefFor(transport) {
  if (transport === "relay") return RELAY_TOKEN_REF;
  if (transport === "max") return MAX_TOKEN_REF;
  return TELEGRAM_TOKEN_REF;
}

/**
 * Строка «X отключён, Y подключён» для ответа connect (038). Если прежнего
 * канала не было — null: сообщение про привязку скажет само.
 */
export function switchNoteFor(previousTransport, nextTransport) {
  if (previousTransport === null || previousTransport === undefined) return null;
  if (previousTransport === nextTransport) return null;
  return tx("commands.switchNoteFor.1", { p0: transportLabel(previousTransport), p1: transportLabel(nextTransport) });
}

/** Адрес Bot API; переопределяется в тестах. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Сколько живёт pairing-код: 10 минут. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Таймаут long polling при ожидании кода и пауза между опросами. */
const PAIRING_POLL_TIMEOUT_SEC = 5;
const PAIRING_POLL_INTERVAL_MS = 1000;

/** Справка на выбранном языке (RU/EN); имена команд остаются латиницей. */
function helpText(lang = DEFAULT_LANG) {
  const code = normalizeLang(lang) ?? DEFAULT_LANG;
  return [
    t("commands.helpTitle", {}, code),
    t("commands.helpConnect", {}, code),
    t("commands.helpOnOff", {}, code),
    t("commands.helpAll", {}, code),
    t("commands.helpHybrid", {}, code),
    t("commands.helpNoHybrid", {}, code),
    t("commands.helpStatusLong", {}, code),
    t("commands.helpAudit", {}, code),
    t("commands.helpTest", {}, code),
    t("commands.helpWho", {}, code),
    t("commands.helpDoctor", {}, code),
    t("commands.helpStats", {}, code),
    t("commands.helpVacuum", {}, code),
    t("commands.helpLang", {}, code),
    t("commands.helpChannel", {}, code),
    t("commands.helpForce", {}, code),
    t("commands.helpTransport", {}, code),
    t("commands.helpChannelList", {}, code),
    t("commands.helpChannelRemove", {}, code),
    t("commands.helpDisconnect", {}, code),
    t("commands.helpFooter", {}, code),
  ].join("\n");
}

/**
 * Версия плагина из `package.json` (для `doctor`).
 * @returns строка версии или null.
 */
export function readPluginVersion() {
  try {
    const file = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Отчёт `doctor` человеческим текстом: пункт, деталь и что делать.
 * @param checks - список `{level: ok|warn|fail, title, detail, hint?}`.
 * @returns текст для команды.
 */
export function formatDoctorReport(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const lines = list.map((check) => {
    const head = `[${check.level}] ${check.title}: ${check.detail ?? ""}`;
    return check.hint === undefined || check.hint === "" ? head : `${head}\n      → ${check.hint}`;
  });
  const failed = list.filter((check) => check.level === "fail").length;
  const warned = list.filter((check) => check.level === "warn").length;
  const summary = failed > 0
    ? tx("commands.formatDoctorReport.1", { p0: failed, p1: warned })
    : warned > 0
      ? tx("commands.formatDoctorReport.2", { p0: warned })
      : tx("commands.formatDoctorReport.3");
  return [...lines, "", summary].join("\n");
}

/**
 * Проверки `doctor` на инжектируемых сервисах: без сети и без реальных часов.
 *
 * Уровни: `ok` — всё нормально, `warn` — работает, но стоит поправить, `fail` —
 * без этого удалённый режим не заработает. Каждый пункт с подсказкой «что
 * делать», иначе диагностика бесполезна.
 *
 * @param options - `{store, credentials, transport, telegramCallImpl, version, now}`.
 * @returns список проверок.
 */
export async function runDoctorChecks({
  store = null,
  credentials = null,
  transport = null,
  telegramCallImpl = null,
  version = null,
  now = () => Date.now(),
} = {}) {
  const checks = [];
  const add = (level, title, detail, hint) => {
    checks.push({ level, title, detail: String(detail ?? ""), ...(hint === undefined ? {} : { hint }) });
  };

  add(
    version === null ? "warn" : "ok",
    tx("commands.runDoctorChecks.1"),
    version === null ? tx("commands.runDoctorChecks.2") : `dsh-remote ${version}`,
    version === null ? tx("commands.runDoctorChecks.3") : undefined,
  );

  // --- токен ---------------------------------------------------------------
  // 039: проверяем секрет АКТИВНОГО канала (MAX живёт по своему токену).
  const binding = typeof store?.read === "function" ? store.read()?.bindings ?? null : null;
  const activeTransport = typeof binding?.transport === "string" ? binding.transport : "telegram";
  const tokenRef = tokenRefFor(activeTransport);
  let token = null;
  const access = credentials;
  if (access === null || typeof access?.availableFor !== "function") {
    add("fail", tx("commands.runDoctorChecks.4"), tx("commands.runDoctorChecks.5"), tx("commands.runDoctorChecks.6"));
  } else if (!access.availableFor(tokenRef)) {
    add("fail", tx("commands.runDoctorChecks.4"), tx("commands.runDoctorChecks.7", { p0: tokenRef }), tx("commands.runDoctorChecks.8"));
  } else {
    try {
      token = await access.resolve(tokenRef);
    } catch {
      token = null;
    }
    if (typeof token !== "string" || token === "") {
      add("fail", tx("commands.runDoctorChecks.4"), tx("commands.runDoctorChecks.9", { p0: tokenRef }), tx("commands.runDoctorChecks.10"));
      token = null;
    } else {
      const info = typeof access.describe === "function" ? await access.describe(tokenRef).catch(() => null) : null;
      const source = typeof info?.source === "string" ? info.source : "unknown";
      const readonly = info?.writable === false ? tx("commands.runDoctorChecks.11") : "";
      add("ok", tx("commands.runDoctorChecks.4"), tx("commands.runDoctorChecks.12", { p0: tokenRef, p1: source, p2: readonly }));
    }
  }

  // --- MAX: живость канала и marker (039) -----------------------------------
  if (transport?.id === "max") {
    let health = null;
    try {
      health = await transport.healthCheck?.();
    } catch (error) {
      add("fail", tx("commands.runDoctorChecks.13"), tx("commands.runDoctorChecks.14", { p0: humanError(error, token) }), tx("commands.runDoctorChecks.15"));
    }
    if (health !== null) {
      // 048: показываем активный хост — видно, что сработал фолбэк на api.
      const hostNote = maxHostNote(transport);
      add(
        health?.ok === true ? "ok" : "fail",
        tx("commands.runDoctorChecks.13"),
        tx("commands.runDoctorChecks.16", { p0: health?.detail ?? "?", p1: transport.marker ?? "?", p2: transport.polling === true ? tx("commands.runDoctorChecks.49") : tx("commands.runDoctorChecks.50") })
          + `${hostNote === null ? "" : `; ${hostNote}`}`,
        health?.ok === true ? undefined : tx("commands.runDoctorChecks.17"),
      );
    }
  }

  // --- getMe ---------------------------------------------------------------
  if (activeTransport === "telegram" && token !== null && typeof telegramCallImpl === "function") {
    try {
      const me = await telegramCallImpl(token, "getMe", {});
      const username = me?.result?.username ?? me?.username ?? null;
      add(
        typeof username === "string" && username !== "" ? "ok" : "warn",
        "getMe",
        typeof username === "string" && username !== "" ? tx("commands.runDoctorChecks.18", { p0: username }) : tx("commands.runDoctorChecks.19"),
        typeof username === "string" && username !== "" ? undefined : tx("commands.runDoctorChecks.20"),
      );
    } catch (error) {
      add("fail", "getMe", tx("commands.runDoctorChecks.21", { p0: humanError(error, token) }), tx("commands.runDoctorChecks.22"));
    }
  } else if (activeTransport === "telegram" && token !== null) {
    add("warn", "getMe", tx("commands.runDoctorChecks.23"));
  }

  // --- поллеры -------------------------------------------------------------
  const lock = typeof store?.lockState === "function" ? store.lockState() : null;
  if (lock === null) {
    add("warn", tx("commands.runDoctorChecks.24"), tx("commands.runDoctorChecks.25"), tx("commands.runDoctorChecks.26"));
  } else if (lock.held !== true) {
    add("ok", tx("commands.runDoctorChecks.24"), tx("commands.runDoctorChecks.27"));
  } else if (lock.mine === true) {
    add("ok", tx("commands.runDoctorChecks.24"), tx("commands.runDoctorChecks.28", { p0: lock.holder?.pid ?? "?" }));
  } else {
    add(
      "warn",
      tx("commands.runDoctorChecks.24"),
      tx("commands.runDoctorChecks.29", { p0: lock.holder?.pid ?? "?" }),
      tx("commands.runDoctorChecks.30"),
    );
  }

  // --- канал ---------------------------------------------------------------
  if (transport === null) {
    add("warn", tx("commands.runDoctorChecks.13"), tx("commands.runDoctorChecks.31"), tx("commands.runDoctorChecks.32"));
  } else {
    const lastError = transport.lastError ?? null;
    const updateId = transport.lastUpdateId ?? null;
    if (lastError !== null) {
      add("warn", tx("commands.runDoctorChecks.13"), tx("commands.runDoctorChecks.33", { p0: humanError(lastError, token) }), tx("commands.runDoctorChecks.34"));
    } else if (Number.isFinite(updateId) && updateId >= 0) {
      add("ok", tx("commands.runDoctorChecks.13"), tx("commands.runDoctorChecks.35", { p0: updateId }));
    } else {
      add("ok", tx("commands.runDoctorChecks.13"), tx("commands.runDoctorChecks.36"));
    }
  }

  // --- состояние и права ---------------------------------------------------
  const statePath = typeof store?.paths?.file === "string" ? store.paths.file : null;
  if (statePath === null) {
    add("warn", tx("commands.runDoctorChecks.37"), tx("commands.runDoctorChecks.38"), tx("commands.runDoctorChecks.39"));
  } else {
    let text = null;
    let mode = null;
    try {
      text = fs.readFileSync(statePath, "utf8");
      mode = fs.statSync(statePath).mode & 0o777;
    } catch (error) {
      const missing = error?.code === "ENOENT";
      add(missing ? "warn" : "fail", tx("commands.runDoctorChecks.37"), missing ? tx("commands.runDoctorChecks.40") : tx("commands.runDoctorChecks.41", { p0: humanError(error) }), tx("commands.runDoctorChecks.39"));
    }
    if (text !== null) {
      // Права проверяем независимо от содержимого: битый JSON — отдельная
      // проблема, но файл с 644 не должен проходить незамеченным.
      if (mode !== null) {
        add(
          mode === 0o600 ? "ok" : "warn",
          tx("commands.runDoctorChecks.42"),
          `state.json: ${mode.toString(8)}`,
          mode === 0o600 ? undefined : tx("commands.runDoctorChecks.43", { p0: statePath }),
        );
      }
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        add("fail", tx("commands.runDoctorChecks.37"), tx("commands.runDoctorChecks.44"), tx("commands.runDoctorChecks.45"));
      }
      if (parsed !== null && typeof parsed === "object") {
        const binding = parsed.bindings ?? null;
        add(
          binding === null ? "warn" : "ok",
          tx("commands.runDoctorChecks.37"),
          binding === null ? tx("commands.runDoctorChecks.46") : tx("commands.runDoctorChecks.47", { p0: binding.transport ?? "telegram", p1: binding.botUsername ?? "?" }),
          binding === null ? tx("commands.runDoctorChecks.48") : undefined,
        );
      }
    }
  }

  void now;
  return checks;
}

/** `{kind:'success', text}` — то, что команда возвращает человеку. */
function success(text) {
  return { kind: "success", text };
}

/** `{kind:'error', text}` — ошибка человеческим текстом, без stacktrace. */
function failure(text) {
  return { kind: "error", text };
}

/** Текст ошибки без стека и без токена (токен вырезаем до показа человеку). */
function humanError(error, token) {
  const message = error instanceof Error ? (error.message || error.name) : String(error ?? tx("commands.humanError.1"));
  return token === undefined || token === null || token === "" ? message : message.split(token).join("<token>");
}

/**
 * Хост MAX для `status`/`doctor` (048): видно, сработал ли TLS-фолбэк.
 * `null` — транспорт не MAX (или не сообщает базу, как тестовые заглушки).
 */
function maxHostNote(transport) {
  const endpoint = transport?.endpoint ?? null;
  if (endpoint === null || typeof endpoint !== "object") return null;
  const active = maxHostOf(endpoint.active ?? endpoint.primary ?? "");
  if (active === "") return null;
  if (endpoint.fallbackUsed === true) {
    const primary = maxHostOf(endpoint.primary ?? "");
    return tx("commands.maxHostNote.1", { p0: active, p1: primary === "" ? "platform-api2.max.ru" : primary });
  }
  if (endpoint.fallback === null) return tx("commands.maxHostNote.2", { p0: active });
  return tx("commands.maxHostNote.3", { p0: active });
}

/** Шесть цифр pairing-кода. */
export function pairingCode(random = Math.random) {
  return String(Math.floor(random() * 1_000_000)).padStart(6, "0");
}

/** Похоже ли на токен Bot API: `<цифры>:<строка>`. */
function looksLikeToken(value) {
  return typeof value === "string" && /^\d{3,}:[A-Za-z0-9_-]{10,}$/.test(value);
}

/** Разбор `rawInput`: подкоманда и флаги `--all`/`--session`. */
export function parseRemoteArgs(rawInput) {
  const text = String(rawInput ?? "").trim();
  if (text === "") return { subcommand: "status", flags: new Set(), rest: [] };
  const parts = text.split(/\s+/);
  const tokens = parts.slice(1).filter((part) => part.startsWith("--"));
  const flags = new Set(tokens.map((part) => part.slice(2).split("=")[0].toLowerCase()));
  const flagValues = new Map();
  for (const token of tokens) {
    const [name, value] = token.slice(2).split("=");
    if (value !== undefined && value !== "") flagValues.set(name.toLowerCase(), value);
  }
  return {
    subcommand: parts[0].toLowerCase(),
    flags,
    flagValues,
    rest: parts.slice(1).filter((part) => !part.startsWith("--")),
  };
}

/**
 * @param {object} options
 * @param {object} options.ctx — контекст плагина.
 * @param {object} options.store — хранилище состояния (`store.js`).
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {() => number} [options.random]
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.baseUrl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.pairingTtlMs]
 * @param {() => Promise<object|null>} [options.ensureTransport] — поднять канал
 *   после привязки (фича `commands` создаёт транспорт из состояния); без него
 *   транспорт стартует только при следующей загрузке профиля.
 */
export function createRemoteCommands({
  ctx,
  store,
  log = () => {},
  now = () => Date.now(),
  random = Math.random,
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = TELEGRAM_API_BASE,
  /**
   * 048: явная база MAX (`config.maxApiBase`/`MAX_API_BASE`). Не задана —
   * transport сам берёт api2 и при TLS-ошибке повторяет на platform-api.max.ru.
   */
  maxApiBase = undefined,
  /** 039: `GET /updates?timeout=…` для pairing (long polling, не короткий опрос). */
  maxPairingPollTimeoutSec = MAX_PAIRING_POLL_TIMEOUT_SEC,
  /** 050: общий дедлайн pairing (не «висеть вечно»), мс. */
  maxPairingDeadlineMs = 120_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pairingTtlMs = PAIRING_TTL_MS,
  ensureTransport = null,
  /** Живой транспорт канала (фасад): null, если канала нет. */
  currentChannel = null,
  /** 046: язык из конфига плагина (если `/remote lang` ещё не задан). */
  lang = null,
  testAnswerTimeoutMs = 30 * 60 * 1000,
  setTimeout: setTimeoutImpl = setTimeout,
} = {}) {
  const registry = createRegistry({ readState: () => store.read().enabled, log });
  const credentials = createCredentialAccess(ctx, { log });

  /** Журнал решений (026): читаем тот же `audit.jsonl`, куда пишет ответчик. */
  const audit = createAudit({
    ...(typeof store?.paths?.dir === "string" && store.paths.dir !== "" ? { dir: store.paths.dir } : {}),
    log,
  });

  /**
   * Живой транспорт канала: у фасада (005) — `current`, у обычного сервиса — он
   * сам. `null` значит «канала нет»: отправлять некуда, вопрос должен уйти в GUI.
   */
  function liveTransport() {
    if (typeof currentChannel === "function") {
      const live = currentChannel();
      if (live !== null && live !== undefined) return live;
    }
    const service = ctx?.get?.("remoteTransport") ?? null;
    if (service === null) return null;
    if (service.__isTransportFacade === true) return service.current ?? null;
    return service;
  }

  /** cwd текущей сессии: из неё берётся scope «воркспейс». */
  function sessionInfo(invocation) {
    const sessionId = invocation?.agent?.session?.id ?? null;
    let cwd = null;
    try {
      const sessions = ctx?.get?.("sessions");
      cwd = sessions?.get?.(sessionId)?.header?.cwd ?? null;
    } catch (error) {
      log(`sessions.get: ${error?.message ?? error}`);
    }
    return { sessionId, cwd };
  }

  /** Локальный вопрос человеку: это GUI, не мессенджер (режим ещё выключен). */
  async function askStep(invocation, { id, question, options }) {
    const service = serviceOf(ctx, "userQuestions");
    if (typeof service?.ask !== "function") {
      throw new Error(tx("commands.askStep.1"));
    }
    const item = {
      id,
      question,
      ...(options === undefined ? {} : { options: options.map((label) => ({ label })) }),
    };
    const answer = await service.ask({
      questions: [item],
      agent: invocation?.agent,
      signal: invocation?.signal,
    });
    const entry = (Array.isArray(answer?.answers) ? answer.answers : []).find((item2) => item2?.id === id);
    return {
      selected: Array.isArray(entry?.selected) ? entry.selected : [],
      custom: typeof entry?.custom === "string" ? entry.custom.trim() : "",
    };
  }

  /** Один вызов Bot API: `ok:false` превращается в ошибку с кодом. */
  async function telegramCall(token, method, payload = {}, { signal } = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new Error(tx("commands.telegramCall.1", { p0: method, p1: humanError(error, token) }));
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (body?.ok === true) return body.result;
    const status = Number(response?.status ?? 0);
    const error = new Error(tx("commands.telegramCall.2", { p0: method, p1: status, p2: humanError(body?.description ?? tx("commands.pollForCode.4"), token) }));
    error.code = status;
    error.retryAfterSec = Math.max(0, Number(body?.parameters?.retry_after ?? 0));
    throw error;
  }

  /**
   * Ждём сообщение с кодом боту. Пока человек отправляет код, поллинг идёт
   * параллельно; по истечении TTL возвращаем null — привязки не будет.
   */
  async function pollForCode({ token, code, deadline, signal }) {
    let offset = 0;
    while (now() < deadline) {
      if (signal?.aborted) throw new Error(tx("commands.pollForCode.1"));
      let updates;
      try {
        updates = await telegramCall(token, "getUpdates", {
          offset,
          timeout: PAIRING_POLL_TIMEOUT_SEC,
          allowed_updates: ["message"],
        }, { signal });
      } catch (error) {
        if (error?.code === 409) {
          throw new Error(tx("commands.pollForCode.2"));
        }
        if (error?.code === 429) await sleep(Math.max(1000, error.retryAfterSec * 1000));
        else if (error?.code === 401) throw new Error(tx("commands.pollForCode.3"));
        else await sleep(PAIRING_POLL_INTERVAL_MS);
        continue;
      }
      for (const update of Array.isArray(updates) ? updates : []) {
        const updateId = Number(update?.update_id);
        if (Number.isFinite(updateId)) offset = updateId + 1;
        const message = update?.message;
        const text = typeof message?.text === "string" ? message.text.trim() : "";
        if (text !== code) continue;
        return { chatId: message?.chat?.id ?? null, userId: message?.from?.id ?? null };
      }
      await sleep(PAIRING_POLL_INTERVAL_MS);
    }
    return null;
  }

  /**
   * Выбранный scope режима — планом, без записи.
   *
   * Запись делает connect одним `store.update` вместе с привязкой: если что-то
   * упадёт, состояние не останется «наполовину обновлённым».
   */
  function planConnectScope(answer, invocation) {
    const selected = String(answer.selected[0] ?? "").toLowerCase();
    // Метки локализованы (049): сравниваем с обоими языками словаря.
    const labels = (key) => [t(key, {}, "ru"), t(key, {}, "en")].map((label) => label.toLowerCase());
    if (labels("commands.connect.16").includes(selected)) {
      return { plan: { kind: "global" }, note: tx("commands.planConnectScope.1") };
    }
    if (labels("commands.connect.15").includes(selected)) {
      const { cwd } = sessionInfo(invocation);
      if (cwd === null) return { plan: null, note: tx("commands.planConnectScope.2") };
      return { plan: { kind: "workspace", id: cwd }, note: tx("commands.planConnectScope.3", { p0: cwd }) };
    }
    return { plan: null, note: tx("commands.planConnectScope.4") };
  }

  /**
   * Остановить каналы конкретного транспорта (038): фасад, если в нём он, и
   * каналы из реестра 012. Другие транспорты не трогаем — ими управляет их
   * фича/конфиг, а не переключение привязки.
   */
  async function stopTransportChannels(transportId) {
    const facade = ctx?.get?.("remoteTransport") ?? null;
    if (facade !== null && typeof facade.stop === "function") {
      const currentId = facade?.current?.id ?? null;
      if (currentId === null || currentId === transportId) {
        try {
          await facade.stop();
        } catch (error) {
          log(tx("commands.stopTransportChannels.1", { p0: humanError(error) }));
        }
      }
    }
    const channels = ctx?.get?.("remoteTransports") ?? null;
    if (channels !== null && typeof channels.values === "function") {
      for (const channel of [...channels.values()]) {
        if (channel === null || channel?.id !== transportId || typeof channel.stop !== "function") continue;
        try {
          await channel.stop();
        } catch (error) {
          log(tx("commands.stopTransportChannels.2", { p0: transportId, p1: humanError(error) }));
        }
        try {
          channels.delete?.(channel.id);
        } catch {
          /* реестр мог быть очищен */
        }
      }
    }
  }

  /**
   * Отключить текущую привязку перед записью новой (038).
   *
   * Порядок важен: сначала останавливаем канал(ы) прежнего транспорта, потом
   * убираем его токен, и только затем connect пишет новую привязку. Если
   * остановка не удалась, всё равно идём дальше: новая привязка и токен важнее,
   * а старый поллер получит 409 и не сможет мешать (и это видно в логе).
   */
  async function retireActiveChannel(nextTransport) {
    const previous = store.read().bindings;
    if (previous === null) return { previous: null, switchNote: null, secretNote: null };
    const previousTransport = typeof previous.transport === "string" ? previous.transport : "telegram";
    // 038: сначала снимаем открытые вопросы прежнего канала (пока он жив и может
    // закрыть сообщения), затем останавливаем его. Иначе вопрос остался бы с
    // кнопками, а ответ закрывал бы уже новый канал.
    try {
      const cancellation = await ctx?.get?.("remoteAnswerer")?.cancelChannel?.(previousTransport, tx("commands.retireActiveChannel.1"));
      if (Number.isFinite(cancellation) && cancellation > 0) {
        log(tx("commands.retireActiveChannel.2", { p0: cancellation }));
      }
    } catch (error) {
      log(tx("commands.retireActiveChannel.3", { p0: humanError(error) }));
    }
    await stopTransportChannels(previousTransport);

    let secretNote = null;
    try {
      const ref = tokenRefFor(previousTransport);
      const described = await credentials.describe(ref);
      if (described?.present === true) {
        if (described.writable === true) {
          secretNote = (await credentials.unset(ref))
            ? tx("commands.retireActiveChannel.4", { p0: ref })
            : tx("commands.retireActiveChannel.5", { p0: ref });
        } else {
          secretNote = tx("commands.retireActiveChannel.6", { p0: ref });
        }
      }
    } catch (error) {
      log(tx("commands.retireActiveChannel.7", { p0: humanError(error) }));
    }

    return {
      previous: previousTransport,
      switchNote: switchNoteFor(previousTransport, nextTransport),
      secretNote,
    };
  }

  /** `/remote connect` — пошаговая привязка бота. */
  /**
   * `/remote connect relay`: URL релея + токен агента (секрет), проверка `/healthz`.
   *
   * В протоколе v1 плагин — **агент** (публикует вопросы и читает ответы), поэтому
   * ему нужен `RELAY_AGENT_TOKEN` сервера, а не `deviceToken` телефона: pairing-код
   * выдаёт токен устройству, которое не может публиковать вопросы (403). Это
   * осознанное отличие от формулировки карточки, зафиксировано в README.
   */
  async function connectRelay(invocation) {
    const urlAnswer = await askStep(invocation, {
      id: "remote-connect-relay-url",
      question: tx("commands.connectRelay.1"),
    });
    const url = String(urlAnswer.custom ?? "").trim().replace(/\/+$/, "");
    if (url === "" || !/^https?:\/\//.test(url)) {
      return failure(tx("commands.connectRelay.2"));
    }

    const tokenAnswer = await askStep(invocation, {
      id: "remote-connect-relay-token",
      question: tx("commands.connectRelay.3", { p0: RELAY_TOKEN_REF }),
    });
    const token = String(tokenAnswer.custom ?? "").trim();
    if (token === "") return failure(tx("commands.connectRelay.4"));

    let health;
    try {
      health = await relayHealth(url, token);
    } catch (error) {
      return failure(tx("commands.connectRelay.5", { p0: humanError(error, token) }));
    }
    if (!health.ok) return failure(tx("commands.connectRelay.6", { p0: health.detail }));
    // Публичный /healthz не проверяет токен: нужен авторизованный пробник,
    // иначе неверный токен сохранится и всплывёт только на отправке вопроса.
    const probe = await relayAuthProbe(url, token);
    if (!probe.ok) return failure(tx("commands.connectRelay.7", { p0: probe.detail }));

    const scopeAnswer = await askStep(invocation, {
      id: "remote-connect-scope",
      question: tx("commands.connectRelay.8"),
      options: [tx("commands.connectRelay.9"), tx("commands.connectRelay.10"), tx("commands.connectRelay.11")],
    });
    const scope = planConnectScope(scopeAnswer, invocation);
    // 038: прежний канал отключаем ДО записи новой привязки.
    const retired = await retireActiveChannel("relay");
    try {
      store.update((state) => {
        state.bindings = {
          transport: "relay",
          url,
          botUsername: "relay",
          createdAt: now(),
          ...(retired.previous !== null && retired.previous !== "relay" ? { previousTransport: retired.previous } : {}),
        };
        if (scope.plan?.kind === "global") state.enabled.global = true;
        if (scope.plan?.kind === "workspace") state.enabled.workspaces[scope.plan.id] = true;
        return state;
      });
    } catch (error) {
      return failure(tx("commands.connectRelay.12", { p0: humanError(error, token) }));
    }
    const saved = await credentials.set(RELAY_TOKEN_REF, token);
    const tokenNote = saved
      ? tx("commands.connectRelay.13", { p0: RELAY_TOKEN_REF })
      : credentials.available
        ? tx("commands.connectRelay.14", { p0: RELAY_TOKEN_REF })
        : tx("commands.connectRelay.15", { p0: RELAY_TOKEN_REF });

    // 038: поднимаем канал сразу, чтобы после переключения вопрос шёл в релей,
    // а не в прежний (уже остановленный) транспорт.
    let channelNote = tx("commands.connectRelay.16");
    if (typeof ensureTransport === "function") {
      try {
        const started = await ensureTransport();
        if (started === null) {
          channelNote = tx("commands.connectRelay.17");
        } else {
          channelNote = tx("commands.connectRelay.18");
        }
      } catch (error) {
        log(tx("commands.connectRelay.19", { p0: humanError(error, token) }));
        channelNote = tx("commands.connectRelay.20");
      }
    }

    return success([
      ...(retired.switchNote === null ? [] : [retired.switchNote]),
      ...(retired.secretNote === null ? [] : [retired.secretNote]),
      tx("commands.connectRelay.21", { p0: url, p1: health.detail }),
      tokenNote,
      scope.note,
      channelNote,
    ].join("\n"));
  }

  /**
   * Авторизованный пробник: `GET /v1/answers?questionId=<uuid>`.
   * `404` — токен принят (ответа ещё нет), `401/403` — токен неверный.
   */
  async function relayAuthProbe(url, token) {
    const fetchFn = fetchImpl ?? globalThis.fetch;
    try {
      const response = await fetchFn(`${url}/v1/answers?questionId=${randomUUID()}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, "x-relay-version": "1" },
      });
      if (response.status === 404) return { ok: true, detail: tx("commands.relayAuthProbe.1") };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: `unauthorized (HTTP ${response.status})` };
      }
      return { ok: false, detail: tx("commands.relayAuthProbe.2", { p0: response.status }) };
    } catch (error) {
      return { ok: false, detail: humanError(error, token) };
    }
  }

  /** Проверка живости релея без транспорта: `/healthz` + обязательный заголовок версии. */
  async function relayHealth(url, token) {
    const response = await (fetchImpl ?? globalThis.fetch)(`${url}/healthz`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "x-relay-version": "1" },
    });
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    const body = await response.json();
    return { ok: body?.ok === true, detail: `relay ${body?.version ?? "?"}` };
  }

  /**
   * `/remote connect` → MAX (039): токен → `GET /me` → pairing-код через
   * `GET /updates` → привязка (и отключение прежнего канала, правило 038).
   */
  async function connectMax(invocation) {
    const tokenAnswer = await askStep(invocation, {
      id: "remote-connect-max-token",
      question: tx("commands.connectMax.1")
        + tx("commands.connectMax.2", { p0: MAX_TOKEN_REF }),
    });
    const token = String(tokenAnswer.custom ?? "").trim();
    if (token === "") return failure(tx("commands.connectMax.3"));

    let me;
    try {
      me = await maxMe({ token, apiBase: maxApiBase, fetch: fetchImpl });
    } catch (error) {
      // 048: TLS/сеть — это не «не принял токен»: у ошибки уже есть свой текст
      // про Russian Trusted CA и два варианта решения.
      if (error?.code === "MAX_TLS" || error?.code === "MAX_NETWORK") return failure(humanError(error, token));
      return failure(tx("commands.connectMax.4", { p0: humanError(error, token) }));
    }
    const botName = typeof me?.name === "string" && me.name !== "" ? me.name : tx("commands.connectMax.5");
    // 048: если api2 не прошёл TLS, pairing доопрашиваем по рабочему хосту.
    const pairingBase = me?.fallbackUsed === true && typeof me.apiBase === "string" ? me.apiBase : maxApiBase;
    if (me?.fallbackUsed === true) {
      log(tx("commands.connectMax.6", { p0: maxHostOf(me.primaryBase), p1: maxHostOf(me.apiBase) }));
    }

    const code = pairingCode(random);
    // 050: pairing не может висеть дольше дедлайна; код живёт 10 минут, но
    // человек получает внятный ответ уже через maxPairingDeadlineMs.
    const pollDeadline = now() + Math.max(1_000, Math.floor(maxPairingDeadlineMs));
    await askStep(invocation, {
      id: "remote-connect-max-send-code",
      question: tx("commands.connectMax.7", { p0: botName, p1: code })
        + tx("commands.connectMax.8"),
      options: [tx("commands.connectMax.9")],
    });

    let match;
    const stats = { polls: 0, updates: 0, types: new Set(), codeSeen: 0, host: null };
    try {
      match = await maxPollForCode({
        token,
        code,
        deadline: pollDeadline,
        pollTimeoutSec: maxPairingPollTimeoutSec,
        apiBase: pairingBase,
        fetch: fetchImpl,
        now,
        sleep,
        signal: invocation?.signal,
        log,
        journal: ctx?.get?.("remoteJournal") ?? null,
        stats,
      });
    } catch (error) {
      if (error?.name === "AbortError" || invocation?.signal?.aborted === true) {
        return failure(tx("commands.connectMax.10"));
      }
      const status = Number(error?.status ?? 0);
      if (status === 401 || status === 403) {
        return failure(tx("commands.connectMax.11"));
      }
      if (status === 429) {
        return failure(tx("commands.connectMax.12", { p0: error?.retryAfterMs ? tx("commands.connectMax.32", { p0: Math.round(error.retryAfterMs / 1000) }) : "" }));
      }
      return failure(tx("commands.connectMax.13", { p0: humanError(error, token) }));
    }
    if (match === null) {
      if (stats.lastError?.status === 429) {
        return failure(tx("commands.connectMax.12", { p0: stats.lastError.retryAfterMs ? tx("commands.connectMax.32", { p0: Math.round(stats.lastError.retryAfterMs / 1000) }) : "" }));
      }
      if (stats.lastError?.code === "MAX_TIMEOUT" || Number(stats.lastError?.status) >= 500) {
        const reason = stats.lastError?.code === "MAX_TIMEOUT" ? tx("commands.connectMax.14") : `HTTP ${stats.lastError?.status}`;
        return failure(tx("commands.connectMax.15", { p0: reason }));
      }
      const types = stats.types.size === 0 ? "—" : [...stats.types].join(", ");
      const seconds = Math.round(Math.max(1_000, maxPairingDeadlineMs) / 1000);
      return failure(tx("commands.connectMax.16", { p0: code, p1: seconds, p2: stats.updates })
        + tx("commands.connectMax.17", { p0: types, p1: stats.host ?? "?" }));
    }

    const scopeAnswer = await askStep(invocation, {
      id: "remote-connect-scope",
      question: tx("commands.connectMax.18"),
      options: [tx("commands.connectMax.19"), tx("commands.connectMax.20"), tx("commands.connectMax.21")],
    });
    const scope = planConnectScope(scopeAnswer, invocation);
    // 038: прежний канал отключаем ДО записи новой привязки.
    const retired = await retireActiveChannel("max");
    try {
      store.update((state) => {
        state.bindings = {
          transport: "max",
          chatId: match.chatId,
          userId: match.userId,
          botUsername: botName,
          ...(match.marker === null || match.marker === undefined ? {} : { marker: match.marker }),
          createdAt: now(),
          ...(retired.previous !== null && retired.previous !== "max" ? { previousTransport: retired.previous } : {}),
        };
        if (scope.plan?.kind === "global") state.enabled.global = true;
        if (scope.plan?.kind === "workspace") state.enabled.workspaces[scope.plan.id] = true;
        return state;
      });
    } catch (error) {
      return failure(tx("commands.connectMax.22", { p0: humanError(error, token) }));
    }

    const saved = await credentials.set(MAX_TOKEN_REF, token);
    const tokenNote = saved
      ? tx("commands.connectMax.23", { p0: MAX_TOKEN_REF })
      : credentials.available
        ? tx("commands.connectMax.24", { p0: MAX_TOKEN_REF })
        : tx("commands.connectMax.25", { p0: MAX_TOKEN_REF });

    let channelNote = tx("commands.connectMax.26");
    if (typeof ensureTransport === "function") {
      try {
        const started = await ensureTransport();
        channelNote = started === null
          ? tx("commands.connectMax.27")
          : tx("commands.connectMax.28");
      } catch (error) {
        log(tx("commands.connectMax.29", { p0: humanError(error, token) }));
        channelNote = tx("commands.connectMax.30");
      }
    }

    return success([
      ...(retired.switchNote === null ? [] : [retired.switchNote]),
      ...(retired.secretNote === null ? [] : [retired.secretNote]),
      tx("commands.connectMax.31", { p0: botName, p1: match.chatId, p2: match.userId }),
      tokenNote,
      scope.note,
      channelNote,
    ].join("\n"));
  }

  async function connect(invocation) {
    // Шаги connect спрашиваются локальными вопросами. Если удалённый режим уже
    // включён, ответчик перехватит их и отправит в мессенджер — в том числе
    // вопрос про токен. Поэтому сначала просим выключить.
    const modeInfo = sessionInfo(invocation);
    if (registry.resolve({ sessionId: modeInfo.sessionId, workspace: modeInfo.cwd }).enabled) {
      return failure(tx("commands.connect.1"));
    }
    const lock = store.acquireLock();
    if (!lock.ok) {
      return failure(tx("commands.connect.2", { p0: lock.holder?.pid ?? "?" }));
    }

    let token = null;
    try {
      // Выбор транспорта — до проверок Telegram: у relay свой токен
      // (`DSH_REMOTE_RELAY_TOKEN`), и без Telegram-секрета его тоже можно подключить.
      const choice = await askStep(invocation, {
        id: "remote-connect-transport",
        question: tx("commands.connect.3"),
        options: ["Telegram", tx("commands.connect.4"), "MAX"],
      });
      if (choice.selected[0]?.startsWith("MAX") === true) {
        return await connectMax(invocation);
      }
      if (choice.selected[0]?.startsWith("Relay") === true) {
        return await connectRelay(invocation);
      }
      if (!credentials.availableFor(TELEGRAM_TOKEN_REF)) {
        return failure(tx("commands.connect.5", { p0: TELEGRAM_TOKEN_REF }));
      }

      const tokenAnswer = await askStep(invocation, {
        id: "remote-connect-token",
        question: tx("commands.connect.6"),
      });
      token = tokenAnswer.custom;
      if (token === "") return failure(tx("commands.connect.7"));
      if (!looksLikeToken(token)) return failure(tx("commands.connect.8"));

      const me = await telegramCall(token, "getMe");
      const botUsername = typeof me?.username === "string" ? me.username : null;
      if (botUsername === null) return failure(tx("commands.connect.9"));

      const code = pairingCode(random);
      const deadline = now() + pairingTtlMs;
      await askStep(invocation, {
        id: "remote-connect-send-code",
        question: tx("commands.connect.10", { p0: botUsername, p1: code }),
        options: [tx("commands.connect.11")],
      });

      const match = await pollForCode({ token, code, deadline, signal: invocation?.signal });
      if (match === null) {
        return failure(tx("commands.connect.12", { p0: code }));
      }
      if (match.chatId === null || match.userId === null) {
        return failure(tx("commands.connect.13"));
      }

      // Сначала спрашиваем про режим: если человек закроет вопрос, привязка не
      // появится «наполовину» — состояние меняется одним заходом в конце.
      const scopeAnswer = await askStep(invocation, {
        id: "remote-connect-scope",
        question: tx("commands.connect.14"),
        options: [tx("commands.connect.15"), tx("commands.connect.16"), tx("commands.connect.17")],
      });

      const scope = planConnectScope(scopeAnswer, invocation);
      // 038: прежний канал отключаем ДО записи новой привязки.
      const retired = await retireActiveChannel("telegram");
      try {
        store.update((state) => {
          state.bindings = {
            transport: "telegram",
            chatId: match.chatId,
            userId: match.userId,
            botUsername,
            createdAt: now(),
            ...(retired.previous !== null && retired.previous !== "telegram" ? { previousTransport: retired.previous } : {}),
          };
          if (scope.plan?.kind === "global") state.enabled.global = true;
          if (scope.plan?.kind === "workspace") state.enabled.workspaces[scope.plan.id] = true;
          return state;
        });
      } catch (error) {
        return failure(tx("commands.connect.18", { p0: humanError(error, token) }));
      }

      const saved = await credentials.set(TELEGRAM_TOKEN_REF, token);
      const tokenNote = saved
        ? tx("commands.connect.19", { p0: TELEGRAM_TOKEN_REF })
        : credentials.available
          ? tx("commands.connect.20", { p0: TELEGRAM_TOKEN_REF })
          : tx("commands.connect.21", { p0: TELEGRAM_TOKEN_REF });
      const scopeNote = scope.note;

      // Транспорт мог подняться ещё до привязки (фича telegram спит без неё), а
      // мог и не подняться вовсе (привязки не было при старте профиля). Просим
      // фичу поднять канал из состояния и, если сервис уже есть, — стартовать.
      let channelNote = tx("commands.connect.22");
      let transport = null;
      if (typeof ensureTransport === "function") {
        try {
          transport = await ensureTransport();
        } catch (error) {
          log(tx("commands.connect.23", { p0: humanError(error, token) }));
        }
      }
      if (transport === null) transport = liveTransport();
      if (typeof transport?.start === "function") {
        try {
          const started = await transport.start();
          const live = liveTransport() ?? transport;
          if (started === false || live === null) {
            channelNote = tx("commands.connect.24");
          } else {
            channelNote = tx("commands.connect.25");
          }
        } catch (error) {
          log(tx("commands.connect.26", { p0: humanError(error, token) }));
          channelNote = tx("commands.connect.27");
        }
      }

      return success([
        ...(retired.switchNote === null ? [] : [retired.switchNote]),
        ...(retired.secretNote === null ? [] : [retired.secretNote]),
        tx("commands.connect.28", { p0: botUsername, p1: match.chatId, p2: match.userId }),
        tokenNote,
        scopeNote,
        channelNote,
      ].join("\n"));
    } catch (error) {
      return failure(tx("commands.connect.29", { p0: humanError(error, token) }));
    } finally {
      store.releaseLock();
    }
  }

  /** `/remote on|off [--all|--session]`. */
  async function setMode(invocation, enabled, flags) {
    const { sessionId, cwd } = sessionInfo(invocation);
    if (enabled) {
      // Включённый режим без канала = вопрос уходит в ответчик, который не может
      // его доставить, и сессия висит. Требуем привязку и живой канал.
      const state = store.read();
      if (state.bindings === null && liveTransport() === null) {
        return failure(tx("commands.setMode.1"));
      }
      if (typeof ensureTransport === "function") {
        try {
          await ensureTransport();
        } catch (error) {
          return failure(tx("commands.setMode.2", { p0: humanError(error) }));
        }
      }
      const channel = liveTransport();
      if (channel === null) return failure(tx("commands.setMode.3"));
    }
    try {
      if (flags.has("hybrid")) store.setHybrid({ enabled });
      if (flags.has("no-hybrid")) store.setHybrid({ enabled: false });
      if (flags.has("all")) {
        store.setEnabled({ kind: "global" }, enabled);
        const decision = registry.resolve({ sessionId, workspace: cwd });
        return success(tx("commands.setMode.4", { p0: enabled ? tx("commands.setMode.10") : tx("commands.setMode.11"), p1: describeEffective(decision) }));
      }
      if (flags.has("session")) {
        if (sessionId === null) return failure(tx("commands.setMode.5"));
        store.setEnabled({ kind: "session", id: sessionId }, enabled);
        return success(tx("commands.setMode.6", { p0: enabled ? tx("commands.setMode.10") : tx("commands.setMode.11"), p1: sessionId, p2: describeEffective(registry.resolve({ sessionId, workspace: cwd })) }));
      }
      if (cwd === null) {
        return failure(tx("commands.setMode.7"));
      }
      store.setEnabled({ kind: "workspace", id: cwd }, enabled);
      return success(tx("commands.setMode.8", { p0: enabled ? tx("commands.setMode.10") : tx("commands.setMode.11"), p1: cwd, p2: describeEffective(registry.resolve({ sessionId, workspace: cwd })) }));
    } catch (error) {
      return failure(tx("commands.setMode.9", { p0: humanError(error) }));
    }
  }

  /** Человеческое описание эффективного режима. */
  function describeEffective(decision) {
    const scope = decision.scope === "session" ? tx("commands.describeEffective.1") : decision.scope === "workspace" ? tx("commands.describeEffective.2") : decision.scope === "global" ? tx("commands.describeEffective.3") : tx("commands.describeEffective.4");
    return tx("commands.describeEffective.5", { p0: decision.enabled ? tx("commands.describeEffective.6") : tx("commands.describeEffective.7"), p1: scope });
  }

  /** `/remote status`. */
  /** 046: язык команд: явная настройка состояния → локаль DSH → ru. */
  function currentLang() {
    try {
      return resolveLanguage({ explicit: store.read().lang ?? lang });
    } catch {
      return DEFAULT_LANG;
    }
  }

  /**
   * `/remote lang [ru|en]` — язык пользовательских сообщений без перезапуска.
   * Без аргумента показывает текущий; неизвестный — ошибка с подсказкой.
   */
  async function langCommand(args) {
    const lang = currentLang();
    const value = Array.isArray(args) ? args[0] : undefined;
    if (value === undefined || value === "") {
      return success(t("commands.lang.current", { lang }, lang));
    }
    const normalized = normalizeLang(value);
    if (normalized === null) {
      return failure(t("commands.lang.unknown", { value }, lang));
    }
    store.setLang(normalized);
    return success(t("commands.lang.set", { lang: normalized }, normalized));
  }

  async function status(invocation) {
    const state = store.read();
    const lang = currentLang();
    const { sessionId, cwd } = sessionInfo(invocation);
    const lines = [];

    lines.push(t("commands.status.language", { lang }, lang));
    if (state.bindings === null && liveTransport() === null) {
      lines.push(t("commands.status.notBound", {}, lang));
    } else if (state.bindings === null) {
      // Канал живёт из config профиля (004): привязки через /remote connect нет.
      lines.push(tx("commands.status.1"));
    } else {
      const created = Number.isFinite(state.bindings.createdAt)
        ? new Date(state.bindings.createdAt).toISOString()
        : "?";
      if (state.bindings.transport === "relay") {
        const relay = liveTransport();
        const health = typeof relay?.healthCheck === "function" ? await relay.healthCheck() : { ok: false, detail: tx("commands.status.2") };
        lines.push(tx("commands.status.3", { p0: state.bindings.url ?? "?", p1: health.ok ? tx("commands.status.23") : tx("commands.status.24", { p0: health.detail }) })
          + tx("commands.status.4", { p0: Number.isFinite(relay?.pending) ? tx("commands.status.25", { p0: relay.pending }) : "" }));
        const e2e = relay?.e2e ?? null;
        lines.push(e2e === null
          ? tx("commands.status.5")
          : tx("commands.status.6", { p0: e2e.keyId, p1: e2e.alg }));
      } else if (state.bindings.transport === "max") {
        const live = liveTransport();
        const marker = Number.isFinite(live?.marker) ? live.marker : Number.isFinite(state.bindings.marker) ? state.bindings.marker : null;
        const lastError = live?.lastError ?? null;
        lines.push(tx("commands.status.7", { p0: state.bindings.botUsername ?? "?", p1: state.bindings.chatId, p2: state.bindings.userId, p3: created }));
        lines.push(tx("commands.status.8", { p0: live?.polling === true ? tx("commands.status.26") : tx("commands.status.27"), p1: marker ?? "?" })
          + tx("commands.status.4", { p0: lastError === null ? "" : tx("commands.status.28", { p0: humanError(lastError) }) }));
        const hostNote = maxHostNote(live);
        if (hostNote !== null) lines.push(`max: ${hostNote}`);
        lines.push(tx("commands.status.9"));
      } else {
        lines.push(tx("commands.status.10", { p0: state.bindings.botUsername ?? "?", p1: state.bindings.transport, p2: state.bindings.chatId, p3: state.bindings.userId, p4: created }));
      }
      // 038: история переключения — какой канал был активным до текущего.
      if (typeof state.bindings.previousTransport === "string" && state.bindings.previousTransport !== "") {
        lines.push(tx("commands.status.11", { p0: transportLabel(state.bindings.previousTransport) }));
      }
    }

    // 038: секрет показываем активного канала, а не всегда Telegram.
    const activeSecretRef = typeof state.bindings?.transport === "string"
      ? tokenRefFor(state.bindings.transport)
      : TELEGRAM_TOKEN_REF;
    const described = await credentials.describe(activeSecretRef);
    if (described.source === null) {
      lines.push(t("commands.status.secret", { ref: activeSecretRef }, lang));
    } else {
      lines.push(tx("commands.status.12", { p0: activeSecretRef, p1: described.source, p2: described.writable ? tx("commands.status.29") : tx("commands.status.30") }));
    }

    const hybridState = state.hybrid.enabled ? tx("commands.status.13", { p0: Math.round(state.hybrid.waitMs / 1000) }) : tx("commands.status.14");
    lines.push(t("commands.status.hybrid", { state: hybridState }, lang));
    const hybridStats = ctx?.get?.("remoteAnswerer")?.stats ?? null;
    if (hybridStats !== null && (hybridStats.hybridHanded > 0 || hybridStats.hybridPhoneAnswers > 0)) {
      lines.push(tx("commands.status.15", { p0: hybridStats.hybridHanded, p1: hybridStats.hybridPhoneAnswers }));
    }
    const approvalAudit = audit.stats();
    lines.push(tx("commands.status.16", { p0: approvalAudit.remote, p1: approvalAudit.gui, p2: approvalAudit.timeout, p3: approvalAudit.total }));
    lines.push(tx("commands.status.17", { p0: state.enabled.global ? tx("commands.status.31") : tx("commands.status.14"), p1: cwd === null ? "?" : cwd, p2: cwd !== null && state.enabled.workspaces[cwd] === true ? tx("commands.status.31") : tx("commands.status.14"), p3: sessionId === null ? "?" : sessionId, p4: sessionId !== null && state.enabled.sessions[sessionId] === true ? tx("commands.status.31") : tx("commands.status.14") }));
    lines.push(describeEffective(registry.resolve({ sessionId, workspace: cwd })));

    // 025: действующая политика подтверждений (публикует ответчик approvals 024).
    try {
      const policy = ctx?.get?.("remoteApprovalPolicy") ?? null;
      if (policy !== null && typeof policy?.describe === "function") {
        for (const line of policy.describe(currentLang())) lines.push(line);
      } else {
        lines.push(t("commands.status.approvals", {}, lang));
      }
    } catch (error) {
      lines.push(tx("commands.status.18", { p0: humanError(error) }));
    }

    const channels = Object.entries(state.channels ?? {});
    if (channels.length === 0) {
      lines.push(tx("commands.status.19"));
    } else {
      for (const [name, perTransport] of channels) {
        for (const [transportId, channel] of Object.entries(perTransport)) {
          lines.push(tx("commands.status.20", { p0: name, p1: transportId, p2: channel.chatId, p3: channel.threadId === undefined ? "" : tx("commands.status.32", { p0: channel.threadId }) }));
        }
      }
    }

    const lock = store.lockState();
    lines.push(lock.held ? tx("commands.status.21", { p0: lock.holder?.pid ?? "?" }) : tx("commands.status.22"));

    return success(lines.join("\n"));
  }

  /** Один формат решения для `/remote audit`: время, инструмент, исход, откуда. */
  function auditLine(entry) {
    const date = new Date(typeof entry.ts === "string" ? entry.ts : "");
    const time = Number.isNaN(date.getTime())
      ? "??:??:??"
      : [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
    const decision = entry.decision === "remote"
      ? tx("commands.auditLine.1")
      : entry.decision === "gui"
        ? "GUI"
        : entry.decision === "late" ? tx("commands.auditLine.2") : tx("commands.auditLine.3");
    const parts = [time, entry.toolName ?? "?", entry.outcome ?? "?", decision];
    if (typeof entry.channel === "string" && entry.channel !== "") parts.push(entry.channel);
    if (typeof entry.answeredBy === "string" && entry.answeredBy !== "") parts.push(tx("commands.auditLine.4", { p0: entry.answeredBy }));
    if (Number.isFinite(entry.waitedMs)) parts.push(tx("commands.auditLine.5", { p0: Math.round(entry.waitedMs / 1000) }));
    if (typeof entry.callId === "string" && entry.callId !== "") parts.push(`call ${entry.callId}`);
    return `  ${parts.join(" · ")}`;
  }

  /**
   * `/remote audit [N]` — последние N решений по подтверждениям (по умолчанию 20).
   *
   * Читает append-only журнал `audit.jsonl` (026) и печатает только метаданные:
   * инструмент, исход, откуда решено. Секретов и тел команд там нет по построению
   * (см. `lib/audit.js`), поэтому печатать можно как есть.
   */
  function auditCommand(rest) {
    const raw = Array.isArray(rest) ? rest[0] : undefined;
    let limit = 20;
    if (raw !== undefined && raw !== "") {
      const parsed = Number.parseInt(String(raw), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return failure(tx("commands.auditCommand.1"));
      }
      limit = Math.min(parsed, 200);
    }
    const entries = audit.tail(limit);
    if (entries.length === 0) {
      return success(tx("commands.auditCommand.2"));
    }
    const summary = audit.stats();
    return success([
      tx("commands.auditCommand.3", { p0: entries.length, p1: summary.total }),
      ...entries.map(auditLine),
    ].join("\n"));
  }

  /** `/remote test` — отправить тестовый вопрос через живой транспорт. */
  async function testChannel(invocation) {
    const state = store.read();
    if (state.bindings === null && liveTransport() === null) return failure(tx("commands.testChannel.1"));
    const transport = liveTransport();
    if (transport === null || typeof transport.sendQuestion !== "function") {
      return failure(tx("commands.testChannel.2"));
    }
    const shortId = String(Math.floor(random() * 0xffffffff)).padStart(8, "0").slice(0, 8);
    const question = {
      shortId,
      title: tx("commands.testChannel.3"),
      body: tx("commands.testChannel.4"),
      options: [{ id: "o1", label: tx("commands.testChannel.5") }],
    };
    // Тестовый вопрос не проходит через ответчик (у него свой реестр), поэтому
    // ответ на кнопку закрываем здесь: сообщение не останется с кнопками.
    let off = null;
    let timer = null;
    const cleanup = () => {
      off?.();
      off = null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    try {
      if (typeof transport.onAnswer === "function") {
        off = transport.onAnswer((event) => {
          if (event?.shortId !== shortId) return;
          cleanup();
          void transport.closeQuestion?.(question, tx("commands.testChannel.6"));
        });
        // Если человек так и не нажал — подписка не должна жить вечно.
        timer = setTimeoutImpl(() => {
          cleanup();
          log(tx("commands.testChannel.7", { p0: shortId }));
        }, testAnswerTimeoutMs);
        timer?.unref?.();
      }
      await transport.sendQuestion(question);
    } catch (error) {
      cleanup();
      return failure(tx("commands.testChannel.8", { p0: humanError(error) }));
    }
    store.addRecent({ shortId, sessionId: sessionInfo(invocation).sessionId, status: "test" });
    return success(tx("commands.testChannel.9"));
  }

  /** `/remote who` — кто мы и в каком режиме. */
  function who(invocation) {
    const { sessionId, cwd } = sessionInfo(invocation);
    const decision = registry.resolve({ sessionId, workspace: cwd });
    return success([
      tx("commands.who.1", { p0: sessionId ?? "?" }),
      tx("commands.who.2", { p0: cwd ?? "?" }),
      describeEffective(decision),
    ].join("\n"));
  }

  /** `/remote disconnect` — отвязать бота и выключить режим. */
  /** `/remote channel ...` — каналы проектов (015). */
  function channelCommand(invocation, flags, rest, flagValues = null) {
    // rest — аргументы после подкоманды: `list` | `remove <проект>` |
    // `<проект> <chatId> [threadId]`.
    const args = Array.isArray(rest) ? rest : [];
    const [action, target, threadIdRaw] = args;

    if (action === "list" || action === undefined) {
      const channels = Object.entries(store.read().channels ?? {});
      if (channels.length === 0) return success(tx("commands.channelCommand.1"));
      const lines = [];
      for (const [name, perTransport] of channels) {
        for (const [transportId, channel] of Object.entries(perTransport)) {
          lines.push(tx("commands.channelCommand.2", { p0: name, p1: transportId, p2: channel.chatId, p3: channel.threadId === undefined ? "" : tx("commands.channelCommand.15", { p0: channel.threadId }) }));
        }
      }
      return success(lines.join("\n"));
    }

    if (action === "remove") {
      if (typeof target !== "string" || target === "") return failure(tx("commands.channelCommand.3"));
      const key = target.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop();
      if (!(key in (store.read().channels ?? {}))) return failure(tx("commands.channelCommand.4", { p0: key }));
      const transport = flagValues?.get("transport") ?? null;
      store.removeChannel(target, transport);
      return success(transport === null
        ? tx("commands.channelCommand.5", { p0: key })
        : tx("commands.channelCommand.6", { p0: key, p1: transport }));
    }

    // set: `/remote channel <проект> <chatId> [threadId]`
    const name = action;
    const numericChat = Number(target);
    // У групп и супергрупп Telegram chat_id отрицательный (форумы с топиками тоже),
    // поэтому требуем лишь целое ненулевое число.
    if (!Number.isInteger(numericChat) || numericChat === 0) {
      return failure(tx("commands.channelCommand.7")
        + tx("commands.channelCommand.8"));
    }
    const bindingChat = store.read().bindings?.chatId;
    // Чужой чат: бот может быть в нём не участником, и тогда ответы не придут.
    // Осознанный обход — --force (человек знает, что бот добавлен в чат).
    if (bindingChat !== undefined && bindingChat !== null && String(bindingChat) !== String(numericChat) && !flags.has("force")) {
      return failure(tx("commands.channelCommand.9", { p0: numericChat, p1: bindingChat })
        + tx("commands.channelCommand.10"));
    }
    const transport = flagValues?.get("transport") ?? null;
    let channel = { chatId: numericChat };
    if (threadIdRaw !== undefined && threadIdRaw !== "") {
      const numericThread = Number(threadIdRaw);
      if (!Number.isInteger(numericThread) || numericThread <= 0) {
        return failure(tx("commands.channelCommand.11"));
      }
      channel = { chatId: numericChat, threadId: numericThread };
    }
    if (transport !== null && transport !== "") channel.transport = transport;
    try {
      store.setChannel(name, channel, transport);
    } catch (error) {
      return failure(tx("commands.channelCommand.12", { p0: humanError(error) }));
    }
    return success(tx("commands.channelCommand.13", { p0: name, p1: channel.transport ?? store.read().bindings?.transport ?? "default", p2: channel.chatId })
      + tx("commands.channelCommand.14", { p0: channel.threadId === undefined ? "" : tx("commands.channelCommand.15", { p0: channel.threadId }) }));
  }

  /**
   * `/remote vacuum [--dry-run]` — принудительная очистка старых журналов (033).
   *
   * Оставляем последние `keep` (5) ротированных файлов на каждый журнал;
   * `--dry-run` только показывает, что было бы удалено.
   */
  async function vacuumCommand(invocation, flags) {
    const dir = typeof store?.paths?.dir === "string" ? store.paths.dir : null;
    if (dir === null) return failure(tx("commands.vacuumCommand.1"));
    const dryRun = flags?.has?.("dry-run") === true;
    const result = vacuum(fs, { dir, keep: DEFAULT_KEEP, dryRun, log: (message) => log(message) });
    const size = (bytes) => tx("commands.vacuumCommand.2", { p0: (bytes / 1024).toFixed(1) });
    const lines = [];
    if (result.removed.length === 0) {
      lines.push(dryRun ? tx("commands.vacuumCommand.3") : tx("commands.vacuumCommand.4"));
    } else if (dryRun) {
      lines.push(tx("commands.vacuumCommand.5", { p0: result.removed.length, p1: size(result.freedBytes) }));
      lines.push(...result.removed.map((item) => `  ${path.basename(item.path)} — ${size(item.size)}`));
    } else {
      lines.push(tx("commands.vacuumCommand.6", { p0: result.removed.length, p1: size(result.freedBytes) }));
      lines.push(...result.removed.map((item) => `  ${path.basename(item.path)} — ${size(item.size)}`));
    }
    lines.push(tx("commands.vacuumCommand.7", { p0: result.kept.length, p1: DEFAULT_KEEP }));
    return success(lines.join("\n"));
  }

  /**
   * `/remote stats [--json]` — метрики за время работы плагина (031).
   *
   * Только числа: счётчики вопросов/подтверждений, доставки, латентность,
   * размеры очередей. `--json` — стабильная структура для панели и скриптов.
   */
  async function stats(invocation, flags) {
    const metrics = ctx?.get?.("remoteMetrics") ?? null;
    if (metrics === null || typeof metrics?.snapshot !== "function") {
      return failure(tx("commands.stats.1"));
    }
    // Живые размеры очередей: не мутируем метрики чтением, а кладём в снимок.
    const live = {};
    try {
      const reliability = ctx?.get?.("remoteReliability") ?? null;
      const health = typeof reliability?.healthCheck === "function" ? await reliability.healthCheck() : null;
      if (Number.isFinite(health?.pending)) live.deliveries_pending = health.pending;
      if (Number.isFinite(health?.watching)) live.timers_active = health.watching;
      const approvals = ctx?.get?.("remoteApprovals") ?? null;
      if (Number.isFinite(approvals?.pendingOpen)) live.approvals_open = approvals.pendingOpen;
    } catch (error) {
      log(tx("commands.stats.2", { p0: humanError(error) }));
    }
    const base = metrics.snapshot();
    const snapshot = { ...base, queues: { ...base.queues, ...live } };
    if (flags?.has?.("json") === true) return success(JSON.stringify(snapshot));
    return success(formatStats(snapshot, currentLang()));
  }

  /**
   * `/remote doctor [--json]` — диагностика 2.0 (задача 030).
   *
   * Legacy-проверки 010 остаются (токен, getMe, поллеры, канал, состояние), к ним
   * добавляются credentials/relay/schema/timers; человеческий вывод узнаваем,
   * `--json` — стабильная машиночитаемая структура с кодом возврата.
   */
  async function doctor(invocation, flags) {
    // 049: `--json` — машинный вывод, он не должен зависеть от языка:
    // detail/action строим на каноническом DEFAULT_LANG. Человеческий вывод —
    // на текущем языке.
    const json = flags?.has?.("json") === true;
    commandLang = json ? DEFAULT_LANG : currentLang();
    const legacyChecks = await runDoctorChecks({

      store,
      credentials,
      transport: liveTransport(),
      telegramCallImpl: (token, method) => telegramCall(token, method),
      version: readPluginVersion(),
      now,
    });

    const relayService = ctx?.get?.("remoteRelay") ?? null;
    const live = liveTransport();
    const relay = relayService !== null
      ? { url: relayService.url, transport: relayService.transport }
      : live !== null && live.id === "relay"
        ? { url: store.read().bindings?.url, transport: live }
        : store.read().bindings?.transport === "relay"
          ? { url: store.read().bindings?.url, transport: null }
          : null;

    // Ссылку relay-токена проверяем только когда релей действительно настроен:
    // на Telegram-only установке её отсутствие — норма, а не fail.
    const tokenRefs = relay === null ? [TELEGRAM_TOKEN_REF] : [TELEGRAM_TOKEN_REF, RELAY_TOKEN_REF];
    const checks = await runHealthChecks({
      legacyChecks,
      credentials,
      tokenRefs,
      relay,
      store,
      reliability: ctx?.get?.("remoteReliability") ?? null,
      supportedSchemaVersion: STATE_VERSION,
      lang: commandLang,
    });
    const report = buildReport(checks);
    if (json) {
      return { ...success(serializeReport(report)), exitCode: report.exitCode };
    }
    commandLang = currentLang();
    return { ...success(formatHealthReport(report, commandLang)), exitCode: report.exitCode };
  }

  async function disconnect(invocation) {
    const confirm = await askStep(invocation, {
      id: "remote-disconnect-confirm",
      question: tx("commands.disconnect.1"),
      options: [tx("commands.disconnect.2"), tx("commands.disconnect.3")],
    });
    const confirmLabels = [t("commands.disconnect.2", {}, "ru"), t("commands.disconnect.2", {}, "en")]
      .map((label) => label.toLowerCase());
    if (!confirmLabels.includes(String(confirm.selected[0] ?? "").toLowerCase())) {
      return success(tx("commands.disconnect.4"));
    }

    // 038: чистим токен АКТИВНОГО канала, а не всегда Telegram.
    const activeTransport = (() => {
      const state = store.read();
      const binding = state?.bindings ?? null;
      return typeof binding?.transport === "string" ? binding.transport : "telegram";
    })();
    try {
      store.setBinding(null);
      store.setEnabled({ kind: "global" }, false);
      store.update((state) => {
        state.enabled.workspaces = {};
        state.enabled.sessions = {};
        return state;
      });
    } catch (error) {
      return failure(tx("commands.disconnect.5", { p0: humanError(error) }));
    }

    const activeRef = tokenRefFor(activeTransport);
    const described = await credentials.describe(activeRef);
    let secretNote = tx("commands.disconnect.6", { p0: activeRef });
    if (described.present && described.writable) {
      secretNote = (await credentials.unset(activeRef))
        ? tx("commands.disconnect.7", { p0: activeRef })
        : tx("commands.disconnect.8", { p0: activeRef });
    } else if (described.present) {
      secretNote = tx("commands.disconnect.9", { p0: activeRef });
    }

    const transport = ctx?.get?.("remoteTransport") ?? null;
    if (typeof transport?.stop === "function") {
      try {
        await transport.stop();
      } catch (error) {
        log(`transport.stop: ${humanError(error)}`);
      }
    }
    // Фасад после disconnect пуст: следующий connect поднимет новый транспорт
    // с новым токеном, а не переиспользует старый поллер.
    if (typeof transport?.clear === "function") {
      try {
        transport.clear();
      } catch (error) {
        log(`transport.clear: ${humanError(error)}`);
      }
    }

    // 012: в мультиканальном режиме фасад пуст, а каналы живут в реестре —
    // их тоже надо остановить, иначе после /remote disconnect они продолжат
    // поллить и принимать ответы при уже очищенном состоянии.
    const registry = ctx?.get?.("remoteTransports") ?? null;
    if (registry !== null && typeof registry?.values === "function") {
      for (const channel of [...registry.values()]) {
        if (typeof channel?.stop !== "function") continue;
        try {
          await channel.stop();
        } catch (error) {
          log(tx("commands.disconnect.10", { p0: channel.id ?? "?", p1: humanError(error) }));
        }
      }
      try {
        registry.clear?.();
      } catch (error) {
        log(tx("commands.disconnect.11", { p0: humanError(error) }));
      }
    }

    return success([
      tx("commands.disconnect.12", { p0: transportLabel(activeTransport) }),
      secretNote,
    ].join("\n"));
  }

  /** Обработчик `/remote`: разбор и диспетчеризация. */
  async function handler(invocation) {
    commandLang = currentLang();
    const { subcommand, flags, rest, flagValues } = parseRemoteArgs(invocation?.rawInput);
    try {
      switch (subcommand) {
        case "connect":
          return await connect(invocation);
        case "on":
          return await setMode(invocation, true, flags);
        case "off":
          return await setMode(invocation, false, flags);
        case "status":
          return await status(invocation);
        case "lang":
          return await langCommand(rest);
        case "audit":
          return auditCommand(rest);
        case "test":
          return await testChannel(invocation);
        case "who":
          return who(invocation);
        case "doctor":
          return await doctor(invocation, flags);
        case "stats":
          return await stats(invocation, flags);
        case "vacuum":
          return await vacuumCommand(invocation, flags);
        case "channel":
          return channelCommand(invocation, flags, rest, flagValues);
        case "disconnect":
          return await disconnect(invocation);
        case "help":
        case "?":
          return success(helpText(currentLang()));
        default:
          return success(`${t("commands.unknownSubcommand", { name: subcommand }, currentLang())}\n\n${helpText(currentLang())}`);
      }
    } catch (error) {
      // Сюда попадают отказы userQuestions (человек закрыл вопрос) и прочее:
      // человек должен увидеть текст, а не стек.
      return failure(`/remote ${subcommand}: ${humanError(error)}`);
    }
  }

  const definition = {
    name: "remote",
    description: tx("commands.help.1"),
    input: { hint: "connect|on|off|status|test|who|disconnect" },
    recordInput: false,
    handler,
  };

  /** Зарегистрировать `/remote` в реестре команд DSH. */
  function register() {
    const commands = serviceOf(ctx, "commands");
    if (typeof commands?.register !== "function") {
      log(tx("commands.register.1"));
      return () => {};
    }
    return commands.register(definition) ?? (() => {});
  }

  return { register, handler, definition };
}
