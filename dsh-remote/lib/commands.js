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
  MAX_API_BASE,
  MAX_PAIRING_POLL_TIMEOUT_SEC,
  maxMe,
  maxPollForCode,
} from "./transport/max.js";
import { createAudit } from "./audit.js";
import { DEFAULT_KEEP, vacuum } from "./rotate.js";
import { formatStats } from "./metrics.js";
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
  if (transport === "relay") return "релей";
  return typeof transport === "string" && transport !== "" ? transport : "канал";
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
  return `${transportLabel(previousTransport)} отключён, ${transportLabel(nextTransport)} подключён`;
}

/** Адрес Bot API; переопределяется в тестах. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Сколько живёт pairing-код: 10 минут. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Таймаут long polling при ожидании кода и пауза между опросами. */
const PAIRING_POLL_TIMEOUT_SEC = 5;
const PAIRING_POLL_INTERVAL_MS = 1000;

const HELP_TEXT = [
  "Команды /remote:",
  "  /remote connect    — привязать бота (пошагово, локальными вопросами)",
  "  /remote on|off     — включить/выключить для этого проекта",
  "    --all            — для всех проектов, --session — только для этой сессии",
  "    --hybrid         — гибрид: вопрос уходит в GUI, если в мессенджере молчат N секунд",
  "    --no-hybrid      — выключить гибридный режим",
  "  /remote status     — привязка, режим, источник токена",
  "  /remote audit [N]  — последние N решений по подтверждениям (по умолчанию 20)",
  "  /remote test       — отправить тестовый вопрос в мессенджер",
  "  /remote who        — сессия, воркспейс и эффективный режим",
  "  /remote doctor [--json] — проверка привязки, канала и состояния (ok/warn/fail; JSON для скриптов)",
  "  /remote stats [--json] — метрики: вопросы, подтверждения, доставки, латентность, очереди",
  "  /remote vacuum [--dry-run] — очистить старые ротированные журналы (хранить 5)",
  "  /remote channel <проект> <chatId> [threadId] — канал проекта (топик форума)",
  "    --force          — если бот действительно в другом чате (чужой чат иначе отвергается)",
  "    --transport=<id> — канал для конкретного канала (telegram, max); по умолчанию — транспорт привязки",
  "  /remote channel list — какие каналы у каких проектов",
  "  /remote channel remove <проект> — вернуть проект в общий чат",
  "  /remote disconnect — отвязать бота и выключить режим",
].join("\n");

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
    ? `есть проблемы: ${failed} fail, ${warned} warn — сделайте шаги из подсказок`
    : warned > 0
      ? `работает, но есть предупреждения: ${warned}`
      : "всё в порядке";
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
    "плагин",
    version === null ? "версия не прочитана из package.json" : `dsh-remote ${version}`,
    version === null ? "переустановите пакет: bin/install-remote.sh" : undefined,
  );

  // --- токен ---------------------------------------------------------------
  // 039: проверяем секрет АКТИВНОГО канала (MAX живёт по своему токену).
  const binding = typeof store?.read === "function" ? store.read()?.bindings ?? null : null;
  const activeTransport = typeof binding?.transport === "string" ? binding.transport : "telegram";
  const tokenRef = tokenRefFor(activeTransport);
  let token = null;
  const access = credentials;
  if (access === null || typeof access?.availableFor !== "function") {
    add("fail", "токен", "ctx.credentials недоступен", "задайте секрет или токен в окружении");
  } else if (!access.availableFor(tokenRef)) {
    add("fail", "токен", `нет ссылки ${tokenRef}`, "получите токен у бота и выполните /remote connect");
  } else {
    try {
      token = await access.resolve(tokenRef);
    } catch {
      token = null;
    }
    if (typeof token !== "string" || token === "") {
      add("fail", "токен", `${tokenRef} не разрешился`, "проверьте секрет: /remote connect");
      token = null;
    } else {
      const info = typeof access.describe === "function" ? await access.describe(tokenRef).catch(() => null) : null;
      const source = typeof info?.source === "string" ? info.source : "unknown";
      const readonly = info?.writable === false ? ", только чтение" : "";
      add("ok", "токен", `${tokenRef} найден (источник: ${source}${readonly})`);
    }
  }

  // --- MAX: живость канала и marker (039) -----------------------------------
  if (transport?.id === "max") {
    let health = null;
    try {
      health = await transport.healthCheck?.();
    } catch (error) {
      add("fail", "канал", `MAX: healthCheck упал: ${humanError(error, token)}`, "проверьте сеть и токен MAX; webhook требует HTTPS:443 — используйте long polling");
    }
    if (health !== null) {
      add(
        health?.ok === true ? "ok" : "fail",
        "канал",
        `MAX: ${health?.detail ?? "?"}; marker ${transport.marker ?? "?"}; polling ${transport.polling === true ? "да" : "нет"}`,
        health?.ok === true ? undefined : "проверьте токен MAX и сеть; webhook требует публичного HTTPS:443 — используйте long polling",
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
        typeof username === "string" && username !== "" ? `бот @${username} на связи` : "Telegram ответил без username",
        typeof username === "string" && username !== "" ? undefined : "проверьте токен у @BotFather",
      );
    } catch (error) {
      add("fail", "getMe", `Telegram не ответил: ${humanError(error, token)}`, "проверьте сеть и токен; токен можно перевыпустить у @BotFather");
    }
  } else if (activeTransport === "telegram" && token !== null) {
    add("warn", "getMe", "проверка вне плагина недоступна");
  }

  // --- поллеры -------------------------------------------------------------
  const lock = typeof store?.lockState === "function" ? store.lockState() : null;
  if (lock === null) {
    add("warn", "поллеры", "состояние не подключено", "проверьте установку плагина");
  } else if (lock.held !== true) {
    add("ok", "поллеры", "lock свободен");
  } else if (lock.mine === true) {
    add("ok", "поллеры", `lock держит этот процесс (pid ${lock.holder?.pid ?? "?"})`);
  } else {
    add(
      "warn",
      "поллеры",
      `lock держит pid ${lock.holder?.pid ?? "?"}`,
      "второй поллер получит 409 Conflict: остановите лишний процесс (или дождитесь завершения connect)",
    );
  }

  // --- канал ---------------------------------------------------------------
  if (transport === null) {
    add("warn", "канал", "транспорт не поднят", "привяжите бота: /remote connect");
  } else {
    const lastError = transport.lastError ?? null;
    const updateId = transport.lastUpdateId ?? null;
    if (lastError !== null) {
      add("warn", "канал", `последняя ошибка: ${humanError(lastError, token)}`, "проверьте сеть и токен; поллинг повторяется сам с backoff");
    } else if (Number.isFinite(updateId) && updateId >= 0) {
      add("ok", "канал", `поллинг работает, последний update_id ${updateId}`);
    } else {
      add("ok", "канал", "транспорт поднят");
    }
  }

  // --- состояние и права ---------------------------------------------------
  const statePath = typeof store?.paths?.file === "string" ? store.paths.file : null;
  if (statePath === null) {
    add("warn", "состояние", "state.json не найден", "оно появится после /remote connect");
  } else {
    let text = null;
    let mode = null;
    try {
      text = fs.readFileSync(statePath, "utf8");
      mode = fs.statSync(statePath).mode & 0o777;
    } catch (error) {
      const missing = error?.code === "ENOENT";
      add(missing ? "warn" : "fail", "состояние", missing ? "файла ещё нет" : `не прочитан: ${humanError(error)}`, "оно появится после /remote connect");
    }
    if (text !== null) {
      // Права проверяем независимо от содержимого: битый JSON — отдельная
      // проблема, но файл с 644 не должен проходить незамеченным.
      if (mode !== null) {
        add(
          mode === 0o600 ? "ok" : "warn",
          "права",
          `state.json: ${mode.toString(8)}`,
          mode === 0o600 ? undefined : `должно быть 600: chmod 600 ${statePath}`,
        );
      }
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        add("fail", "состояние", "битый JSON", "удалите файл и выполните /remote connect заново");
      }
      if (parsed !== null && typeof parsed === "object") {
        const binding = parsed.bindings ?? null;
        add(
          binding === null ? "warn" : "ok",
          "состояние",
          binding === null ? "привязки нет" : `привязка: ${binding.transport ?? "telegram"} @${binding.botUsername ?? "?"}`,
          binding === null ? "выполните /remote connect" : undefined,
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
  const message = error instanceof Error ? (error.message || error.name) : String(error ?? "неизвестная ошибка");
  return token === undefined || token === null || token === "" ? message : message.split(token).join("<token>");
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
  maxApiBase = MAX_API_BASE,
  /** 039: `GET /updates?timeout=…` для pairing (long polling, не короткий опрос). */
  maxPairingPollTimeoutSec = MAX_PAIRING_POLL_TIMEOUT_SEC,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pairingTtlMs = PAIRING_TTL_MS,
  ensureTransport = null,
  /** Живой транспорт канала (фасад): null, если канала нет. */
  currentChannel = null,
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
      throw new Error("локальные вопросы недоступны: нет ctx.userQuestions");
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
      throw new Error(`Telegram ${method}: сеть недоступна (${humanError(error, token)})`);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (body?.ok === true) return body.result;
    const status = Number(response?.status ?? 0);
    const error = new Error(`Telegram ${method}: ${status} ${humanError(body?.description ?? "без описания", token)}`);
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
      if (signal?.aborted) throw new Error("подключение отменено");
      let updates;
      try {
        updates = await telegramCall(token, "getUpdates", {
          offset,
          timeout: PAIRING_POLL_TIMEOUT_SEC,
          allowed_updates: ["message"],
        }, { signal });
      } catch (error) {
        if (error?.code === 409) {
          throw new Error("на этот токен уже запущен другой поллер — остановите его и повторите /remote connect");
        }
        if (error?.code === 429) await sleep(Math.max(1000, error.retryAfterSec * 1000));
        else if (error?.code === 401) throw new Error("Telegram не принял токен — проверьте его и повторите");
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
    const selected = answer.selected[0] ?? "";
    if (/все проекты/i.test(selected)) {
      return { plan: { kind: "global" }, note: "включён для всех проектов" };
    }
    if (/только этот проект/i.test(selected)) {
      const { cwd } = sessionInfo(invocation);
      if (cwd === null) return { plan: null, note: "привязка есть, но режим не включён: у сессии нет cwd" };
      return { plan: { kind: "workspace", id: cwd }, note: `включён для воркспейса ${cwd}` };
    }
    return { plan: null, note: "режим пока выключен: включите его /remote on" };
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
          log(`фасад.stop при переключении: ${humanError(error)}`);
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
          log(`канал ${transportId}.stop при переключении: ${humanError(error)}`);
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
      const cancellation = await ctx?.get?.("remoteAnswerer")?.cancelChannel?.(previousTransport, "канал отключён");
      if (Number.isFinite(cancellation) && cancellation > 0) {
        log(`переключение канала: снято открытых вопросов — ${cancellation}`);
      }
    } catch (error) {
      log(`переключение канала: открытые вопросы не сняты (${humanError(error)})`);
    }
    await stopTransportChannels(previousTransport);

    let secretNote = null;
    try {
      const ref = tokenRefFor(previousTransport);
      const described = await credentials.describe(ref);
      if (described?.present === true) {
        if (described.writable === true) {
          secretNote = (await credentials.unset(ref))
            ? `токен ${ref} удалён`
            : `токен ${ref} удалить не удалось — удалите вручную`;
        } else {
          secretNote = `токен ${ref} остался в окружении (источник только для чтения)`;
        }
      }
    } catch (error) {
      log(`секрет прежнего канала не очищен: ${humanError(error)}`);
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
      question: "URL релея (например https://relay.example): в ответе «Другой ответ».",
    });
    const url = String(urlAnswer.custom ?? "").trim().replace(/\/+$/, "");
    if (url === "" || !/^https?:\/\//.test(url)) {
      return failure("URL релея должен начинаться с http:// или https:// — привязка отменена");
    }

    const tokenAnswer = await askStep(invocation, {
      id: "remote-connect-relay-token",
      question: `Токен агента релея (RELAY_AGENT_TOKEN сервера) — сохраним как ${RELAY_TOKEN_REF}. В ответе «Другой ответ».`,
    });
    const token = String(tokenAnswer.custom ?? "").trim();
    if (token === "") return failure("токен не получен — привязка отменена");

    let health;
    try {
      health = await relayHealth(url, token);
    } catch (error) {
      return failure(`релей недоступен: ${humanError(error, token)}`);
    }
    if (!health.ok) return failure(`релей не подтвердил себя: ${health.detail}`);
    // Публичный /healthz не проверяет токен: нужен авторизованный пробник,
    // иначе неверный токен сохранится и всплывёт только на отправке вопроса.
    const probe = await relayAuthProbe(url, token);
    if (!probe.ok) return failure(`релей не принял токен агента: ${probe.detail} — привязка отменена`);

    const scopeAnswer = await askStep(invocation, {
      id: "remote-connect-scope",
      question: "Включить удалённый режим?",
      options: ["Только этот проект", "Все проекты", "Пока не включать"],
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
      return failure(`привязка не сохранена: ${humanError(error, token)}`);
    }
    const saved = await credentials.set(RELAY_TOKEN_REF, token);
    const tokenNote = saved
      ? `токен сохранён как ${RELAY_TOKEN_REF}`
      : credentials.available
        ? `токен не сохранён: источник ${RELAY_TOKEN_REF} только для чтения`
        : `токен взят из окружения (${RELAY_TOKEN_REF}) и не сохранён`;

    // 038: поднимаем канал сразу, чтобы после переключения вопрос шёл в релей,
    // а не в прежний (уже остановленный) транспорт.
    let channelNote = "канал поднимется при следующей загрузке профиля (или после /remote on)";
    if (typeof ensureTransport === "function") {
      try {
        const started = await ensureTransport();
        if (started === null) {
          channelNote = "привязка сохранена, но канал не поднят: проверьте /remote status";
        } else {
          channelNote = "канал поднят: вопросы уходят в релей";
        }
      } catch (error) {
        log(`ensureTransport после привязки релея: ${humanError(error, token)}`);
        channelNote = "канал не поднялся — проверьте /remote status";
      }
    }

    return success([
      ...(retired.switchNote === null ? [] : [retired.switchNote]),
      ...(retired.secretNote === null ? [] : [retired.secretNote]),
      `релей привязан: ${url} (${health.detail})`,
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
      if (response.status === 404) return { ok: true, detail: "токен принят" };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: `unauthorized (HTTP ${response.status})` };
      }
      return { ok: false, detail: `неожиданный ответ HTTP ${response.status}` };
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
      question: "Токен бота MAX (business.max.ru/self → «Чат-боты» → ⋮ → «Настройки») — "
        + `сохраним как ${MAX_TOKEN_REF}. В ответе «Другой ответ».`,
    });
    const token = String(tokenAnswer.custom ?? "").trim();
    if (token === "") return failure("токен MAX не получен — привязка отменена");

    let me;
    try {
      me = await maxMe({ token, apiBase: maxApiBase, fetch: fetchImpl });
    } catch (error) {
      return failure(`MAX не принял токен: ${humanError(error, token)}`);
    }
    const botName = typeof me?.name === "string" && me.name !== "" ? me.name : "MAX-бот";

    const code = pairingCode(random);
    const deadline = now() + pairingTtlMs;
    await askStep(invocation, {
      id: "remote-connect-max-send-code",
      question: `Откройте бота «${botName}» в MAX и отправьте ему код ${code} в течение 10 минут `
        + "(бот MAX заводится только на юрлицо/ИП/самозанятого РФ). Отправили? Нажмите «Отправил».",
      options: ["Отправил"],
    });

    let match;
    try {
      match = await maxPollForCode({
        token,
        code,
        deadline,
        pollTimeoutSec: maxPairingPollTimeoutSec,
        apiBase: maxApiBase,
        fetch: fetchImpl,
        now,
        sleep,
        signal: invocation?.signal,
        log,
      });
    } catch (error) {
      return failure(`не удалось получить код из MAX: ${humanError(error, token)}`);
    }
    if (match === null) {
      return failure(`код ${code} не пришёл боту MAX за 10 минут — привязки нет, повторите /remote connect`);
    }

    const scopeAnswer = await askStep(invocation, {
      id: "remote-connect-scope",
      question: "Включить удалённый режим?",
      options: ["Только этот проект", "Все проекты", "Пока не включать"],
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
      return failure(`привязка не сохранена: ${humanError(error, token)}`);
    }

    const saved = await credentials.set(MAX_TOKEN_REF, token);
    const tokenNote = saved
      ? `токен сохранён как ${MAX_TOKEN_REF}`
      : credentials.available
        ? `токен не сохранён: источник ${MAX_TOKEN_REF} только для чтения`
        : `токен взят из окружения (${MAX_TOKEN_REF}) и не сохранён`;

    let channelNote = "канал поднимется при следующей загрузке профиля (или после /remote on)";
    if (typeof ensureTransport === "function") {
      try {
        const started = await ensureTransport();
        channelNote = started === null
          ? "привязка сохранена, но канал не поднят: проверьте /remote status"
          : "канал поднят: вопросы уходят в MAX";
      } catch (error) {
        log(`ensureTransport после привязки MAX: ${humanError(error, token)}`);
        channelNote = "канал не поднялся — проверьте /remote status";
      }
    }

    return success([
      ...(retired.switchNote === null ? [] : [retired.switchNote]),
      ...(retired.secretNote === null ? [] : [retired.secretNote]),
      `бот MAX «${botName}» привязан (чат ${match.chatId}, человек ${match.userId})`,
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
      return failure("сначала выключите удалённый режим (/remote off): иначе шаги connect уйдут в мессенджер");
    }
    const lock = store.acquireLock();
    if (!lock.ok) {
      return failure(`другой процесс уже настраивает бота (pid ${lock.holder?.pid ?? "?"}) — закройте его и повторите`);
    }

    let token = null;
    try {
      // Выбор транспорта — до проверок Telegram: у relay свой токен
      // (`DSH_REMOTE_RELAY_TOKEN`), и без Telegram-секрета его тоже можно подключить.
      const choice = await askStep(invocation, {
        id: "remote-connect-transport",
        question: "Какой транспорт подключить?",
        options: ["Telegram", "Relay (свой сервер)", "MAX"],
      });
      if (choice.selected[0]?.startsWith("MAX") === true) {
        return await connectMax(invocation);
      }
      if (choice.selected[0]?.startsWith("Relay") === true) {
        return await connectRelay(invocation);
      }
      if (!credentials.availableFor(TELEGRAM_TOKEN_REF)) {
        return failure(`токен неоткуда взять: нет ctx.credentials и нет переменной ${TELEGRAM_TOKEN_REF}`);
      }

      const tokenAnswer = await askStep(invocation, {
        id: "remote-connect-token",
        question: "Пришлите токен бота от @BotFather (в ответе «Другой ответ»).",
      });
      token = tokenAnswer.custom;
      if (token === "") return failure("токен не получен — привязка отменена");
      if (!looksLikeToken(token)) return failure("это не похоже на токен бота: нужен вид <цифры>:<строка>");

      const me = await telegramCall(token, "getMe");
      const botUsername = typeof me?.username === "string" ? me.username : null;
      if (botUsername === null) return failure("Telegram не подтвердил токен — привязка отменена");

      const code = pairingCode(random);
      const deadline = now() + pairingTtlMs;
      await askStep(invocation, {
        id: "remote-connect-send-code",
        question: `Отправьте боту @${botUsername} код ${code} в течение 10 минут. Отправили? Нажмите «Отправил».`,
        options: ["Отправил"],
      });

      const match = await pollForCode({ token, code, deadline, signal: invocation?.signal });
      if (match === null) {
        return failure(`код ${code} не пришёл боту за 10 минут — привязки нет, повторите /remote connect`);
      }
      if (match.chatId === null || match.userId === null) {
        return failure("не удалось определить чат и человека из сообщения — привязка отменена");
      }

      // Сначала спрашиваем про режим: если человек закроет вопрос, привязка не
      // появится «наполовину» — состояние меняется одним заходом в конце.
      const scopeAnswer = await askStep(invocation, {
        id: "remote-connect-scope",
        question: "Включить удалённый режим?",
        options: ["Только этот проект", "Все проекты", "Пока не включать"],
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
        return failure(`привязка не сохранена: ${humanError(error, token)}`);
      }

      const saved = await credentials.set(TELEGRAM_TOKEN_REF, token);
      const tokenNote = saved
        ? `токен сохранён как ${TELEGRAM_TOKEN_REF}`
        : credentials.available
          ? `токен не сохранён: источник ${TELEGRAM_TOKEN_REF} только для чтения`
          : `токен взят из окружения (${TELEGRAM_TOKEN_REF}) и не сохранён`;
      const scopeNote = scope.note;

      // Транспорт мог подняться ещё до привязки (фича telegram спит без неё), а
      // мог и не подняться вовсе (привязки не было при старте профиля). Просим
      // фичу поднять канал из состояния и, если сервис уже есть, — стартовать.
      let channelNote = "канал поднимется при следующей загрузке профиля";
      let transport = null;
      if (typeof ensureTransport === "function") {
        try {
          transport = await ensureTransport();
        } catch (error) {
          log(`ensureTransport после привязки: ${humanError(error, token)}`);
        }
      }
      if (transport === null) transport = liveTransport();
      if (typeof transport?.start === "function") {
        try {
          const started = await transport.start();
          const live = liveTransport() ?? transport;
          if (started === false || live === null) {
            channelNote = "привязка сохранена, но канал не поднят: проверьте /remote status";
          } else {
            channelNote = "канал поднят: вопросы уходят в мессенджер";
          }
        } catch (error) {
          log(`transport.start после привязки: ${humanError(error, token)}`);
          channelNote = "канал не поднялся — проверьте /remote status";
        }
      }

      return success([
        ...(retired.switchNote === null ? [] : [retired.switchNote]),
        ...(retired.secretNote === null ? [] : [retired.secretNote]),
        `бот @${botUsername} привязан (чат ${match.chatId}, человек ${match.userId})`,
        tokenNote,
        scopeNote,
        channelNote,
      ].join("\n"));
    } catch (error) {
      return failure(`подключение не удалось: ${humanError(error, token)}`);
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
        return failure("сначала привяжите бота: /remote connect");
      }
      if (typeof ensureTransport === "function") {
        try {
          await ensureTransport();
        } catch (error) {
          return failure(`канал не поднят: ${humanError(error)}`);
        }
      }
      const channel = liveTransport();
      if (channel === null) return failure("канал не поднят: проверьте токен и /remote status");
    }
    try {
      if (flags.has("hybrid")) store.setHybrid({ enabled });
      if (flags.has("no-hybrid")) store.setHybrid({ enabled: false });
      if (flags.has("all")) {
        store.setEnabled({ kind: "global" }, enabled);
        const decision = registry.resolve({ sessionId, workspace: cwd });
        return success(`режим ${enabled ? "включён" : "выключен"} глобально\n${describeEffective(decision)}`);
      }
      if (flags.has("session")) {
        if (sessionId === null) return failure("не вижу id сессии — используйте --all или запустите из сессии");
        store.setEnabled({ kind: "session", id: sessionId }, enabled);
        return success(`режим ${enabled ? "включён" : "выключен"} для сессии ${sessionId}\n${describeEffective(registry.resolve({ sessionId, workspace: cwd }))}`);
      }
      if (cwd === null) {
        return failure("не вижу cwd сессии — используйте --all (все проекты) или --session (эта сессия)");
      }
      store.setEnabled({ kind: "workspace", id: cwd }, enabled);
      return success(`режим ${enabled ? "включён" : "выключен"} для воркспейса ${cwd}\n${describeEffective(registry.resolve({ sessionId, workspace: cwd }))}`);
    } catch (error) {
      return failure(`не удалось изменить режим: ${humanError(error)}`);
    }
  }

  /** Человеческое описание эффективного режима. */
  function describeEffective(decision) {
    const scope = decision.scope === "session" ? "сессия" : decision.scope === "workspace" ? "воркспейс" : decision.scope === "global" ? "глобально" : "нет настройки";
    return `эффективно: ${decision.enabled ? "включён" : "выключен"} (${scope})`;
  }

  /** `/remote status`. */
  async function status(invocation) {
    const state = store.read();
    const { sessionId, cwd } = sessionInfo(invocation);
    const lines = [];

    if (state.bindings === null && liveTransport() === null) {
      lines.push("бот не привязан: /remote connect");
    } else if (state.bindings === null) {
      // Канал живёт из config профиля (004): привязки через /remote connect нет.
      lines.push("бот не привязан через /remote connect; канал поднят из config профиля");
    } else {
      const created = Number.isFinite(state.bindings.createdAt)
        ? new Date(state.bindings.createdAt).toISOString()
        : "?";
      if (state.bindings.transport === "relay") {
        const relay = liveTransport();
        const health = typeof relay?.healthCheck === "function" ? await relay.healthCheck() : { ok: false, detail: "канал не поднят" };
        lines.push(`релей: ${state.bindings.url ?? "?"}, ${health.ok ? "на связи" : `нет связи (${health.detail})`}`
          + `${Number.isFinite(relay?.pending) ? `, ждёт ответа: ${relay.pending}` : ""}`);
        const e2e = relay?.e2e ?? null;
        lines.push(e2e === null
          ? "e2e: выключен — тело вопроса и варианты идут открытым текстом"
          : `e2e: включён (keyId ${e2e.keyId}, alg ${e2e.alg}) — тело вопроса и варианты шифруются`);
      } else if (state.bindings.transport === "max") {
        const live = liveTransport();
        const marker = Number.isFinite(live?.marker) ? live.marker : Number.isFinite(state.bindings.marker) ? state.bindings.marker : null;
        const lastError = live?.lastError ?? null;
        lines.push(`бот MAX: «${state.bindings.botUsername ?? "?"}», чат ${state.bindings.chatId}, человек ${state.bindings.userId}, привязан ${created}`);
        lines.push(`max: long polling ${live?.polling === true ? "работает" : "не запущен"}, marker ${marker ?? "?"}`
          + `${lastError === null ? "" : `, последняя ошибка: ${humanError(lastError)}`}`);
        lines.push("max: webhook недоступен без публичного HTTPS:443 — используется long polling");
      } else {
        lines.push(`бот: @${state.bindings.botUsername ?? "?"} (${state.bindings.transport}), чат ${state.bindings.chatId}, человек ${state.bindings.userId}, привязан ${created}`);
      }
      // 038: история переключения — какой канал был активным до текущего.
      if (typeof state.bindings.previousTransport === "string" && state.bindings.previousTransport !== "") {
        lines.push(`прежний канал: ${transportLabel(state.bindings.previousTransport)} (отключён)`);
      }
    }

    // 038: секрет показываем активного канала, а не всегда Telegram.
    const activeSecretRef = typeof state.bindings?.transport === "string"
      ? tokenRefFor(state.bindings.transport)
      : TELEGRAM_TOKEN_REF;
    const described = await credentials.describe(activeSecretRef);
    if (described.source === null) {
      lines.push(`секрет: ${activeSecretRef} — не найден`);
    } else {
      lines.push(`секрет: ${activeSecretRef} — источник ${described.source}${described.writable ? " (запись разрешена)" : " (только чтение)"}`);
    }

    lines.push(`гибрид: ${state.hybrid.enabled ? `вкл, ждём ${Math.round(state.hybrid.waitMs / 1000)} с` : "выкл"}`);
    const hybridStats = ctx?.get?.("remoteAnswerer")?.stats ?? null;
    if (hybridStats !== null && (hybridStats.hybridHanded > 0 || hybridStats.hybridPhoneAnswers > 0)) {
      lines.push(`гибрид-метрика: в GUI ${hybridStats.hybridHanded}, ответов из телефона после GUI ${hybridStats.hybridPhoneAnswers}`);
    }
    const approvalAudit = audit.stats();
    lines.push(`подтверждения: удалённо ${approvalAudit.remote}, в GUI ${approvalAudit.gui}, без ответа ${approvalAudit.timeout} (всего ${approvalAudit.total})`);
    lines.push(`режим: глобально ${state.enabled.global ? "вкл" : "выкл"}; проект ${cwd === null ? "?" : cwd} ${cwd !== null && state.enabled.workspaces[cwd] === true ? "вкл" : "выкл"}; сессия ${sessionId === null ? "?" : sessionId} ${sessionId !== null && state.enabled.sessions[sessionId] === true ? "вкл" : "выкл"}`);
    lines.push(describeEffective(registry.resolve({ sessionId, workspace: cwd })));

    // 025: действующая политика подтверждений (публикует ответчик approvals 024).
    try {
      const policy = ctx?.get?.("remoteApprovalPolicy") ?? null;
      if (policy !== null && typeof policy?.describe === "function") {
        for (const line of policy.describe()) lines.push(line);
      } else {
        lines.push("approvals: политика не загружена — удалённые подтверждения только в GUI");
      }
    } catch (error) {
      lines.push(`approvals: политика не прочитана (${humanError(error)})`);
    }

    const channels = Object.entries(state.channels ?? {});
    if (channels.length === 0) {
      lines.push("каналы проектов: нет — все вопросы идут в общий чат");
    } else {
      for (const [name, perTransport] of channels) {
        for (const [transportId, channel] of Object.entries(perTransport)) {
          lines.push(`канал ${name} (${transportId}): чат ${channel.chatId}${channel.threadId === undefined ? "" : `, топик ${channel.threadId}`}`);
        }
      }
    }

    const lock = store.lockState();
    lines.push(lock.held ? `поллер: занят (pid ${lock.holder?.pid ?? "?"})` : "поллер: свободен");

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
      ? "удалённо"
      : entry.decision === "gui"
        ? "GUI"
        : entry.decision === "late" ? "поздний" : "таймаут";
    const parts = [time, entry.toolName ?? "?", entry.outcome ?? "?", decision];
    if (typeof entry.channel === "string" && entry.channel !== "") parts.push(entry.channel);
    if (typeof entry.answeredBy === "string" && entry.answeredBy !== "") parts.push(`ответил ${entry.answeredBy}`);
    if (Number.isFinite(entry.waitedMs)) parts.push(`ждали ${Math.round(entry.waitedMs / 1000)} с`);
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
        return failure("usage: /remote audit [N], где N — целое больше нуля");
      }
      limit = Math.min(parsed, 200);
    }
    const entries = audit.tail(limit);
    if (entries.length === 0) {
      return success("журнал подтверждений пуст: удалённых решений ещё не было");
    }
    const summary = audit.stats();
    return success([
      `Последние ${entries.length} из ${summary.total} решений по подтверждениям:`,
      ...entries.map(auditLine),
    ].join("\n"));
  }

  /** `/remote test` — отправить тестовый вопрос через живой транспорт. */
  async function testChannel(invocation) {
    const state = store.read();
    if (state.bindings === null && liveTransport() === null) return failure("бот не привязан: /remote connect");
    const transport = liveTransport();
    if (transport === null || typeof transport.sendQuestion !== "function") {
      return failure("канал не поднят: /remote connect");
    }
    const shortId = String(Math.floor(random() * 0xffffffff)).padStart(8, "0").slice(0, 8);
    const question = {
      shortId,
      title: "Проверка канала",
      body: "Это тестовый вопрос от dsh-remote. Ответьте любым вариантом.",
      options: [{ id: "o1", label: "Ок" }],
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
          void transport.closeQuestion?.(question, "тест пройден");
        });
        // Если человек так и не нажал — подписка не должна жить вечно.
        timer = setTimeoutImpl(() => {
          cleanup();
          log(`/remote test: ответа на тестовый вопрос ${shortId} не было — подписка снята`);
        }, testAnswerTimeoutMs);
        timer?.unref?.();
      }
      await transport.sendQuestion(question);
    } catch (error) {
      cleanup();
      return failure(`отправить не удалось: ${humanError(error)}`);
    }
    store.addRecent({ shortId, sessionId: sessionInfo(invocation).sessionId, status: "test" });
    return success("тестовый вопрос отправлен — нажмите кнопку в мессенджере, сообщение закроется");
  }

  /** `/remote who` — кто мы и в каком режиме. */
  function who(invocation) {
    const { sessionId, cwd } = sessionInfo(invocation);
    const decision = registry.resolve({ sessionId, workspace: cwd });
    return success([
      `сессия: ${sessionId ?? "?"}`,
      `воркспейс: ${cwd ?? "?"}`,
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
      if (channels.length === 0) return success("каналы проектов не заданы: все вопросы идут в общий чат");
      const lines = [];
      for (const [name, perTransport] of channels) {
        for (const [transportId, channel] of Object.entries(perTransport)) {
          lines.push(`${name} (${transportId}) → чат ${channel.chatId}${channel.threadId === undefined ? "" : `, топик ${channel.threadId}`}`);
        }
      }
      return success(lines.join("\n"));
    }

    if (action === "remove") {
      if (typeof target !== "string" || target === "") return failure("укажите проект: /remote channel remove <проект>");
      const key = target.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop();
      if (!(key in (store.read().channels ?? {}))) return failure(`у проекта ${key} нет своего канала — он и так в общем чате`);
      const transport = flagValues?.get("transport") ?? null;
      store.removeChannel(target, transport);
      return success(transport === null
        ? `проект ${key} снова идёт в общий чат`
        : `у проекта ${key} убран канал транспорта ${transport}`);
    }

    // set: `/remote channel <проект> <chatId> [threadId]`
    const name = action;
    const numericChat = Number(target);
    // У групп и супергрупп Telegram chat_id отрицательный (форумы с топиками тоже),
    // поэтому требуем лишь целое ненулевое число.
    if (!Number.isInteger(numericChat) || numericChat === 0) {
      return failure("chatId должен быть целым ненулевым числом (у групп и супергрупп он отрицательный): "
        + "/remote channel <проект> <chatId>");
    }
    const bindingChat = store.read().bindings?.chatId;
    // Чужой чат: бот может быть в нём не участником, и тогда ответы не придут.
    // Осознанный обход — --force (человек знает, что бот добавлен в чат).
    if (bindingChat !== undefined && bindingChat !== null && String(bindingChat) !== String(numericChat) && !flags.has("force")) {
      return failure(`чат ${numericChat} не совпадает с привязанным (${bindingChat}): это чужой чат. `
        + "Если бот действительно добавлен туда, повторите с --force");
    }
    const transport = flagValues?.get("transport") ?? null;
    let channel = { chatId: numericChat };
    if (threadIdRaw !== undefined && threadIdRaw !== "") {
      const numericThread = Number(threadIdRaw);
      if (!Number.isInteger(numericThread) || numericThread <= 0) {
        return failure("threadId (топик форума) должен быть целым положительным числом");
      }
      channel = { chatId: numericChat, threadId: numericThread };
    }
    if (transport !== null && transport !== "") channel.transport = transport;
    try {
      store.setChannel(name, channel, transport);
    } catch (error) {
      return failure(`канал не сохранён: ${humanError(error)}`);
    }
    return success(`проект ${name} (${channel.transport ?? store.read().bindings?.transport ?? "default"}) → чат ${channel.chatId}`
      + `${channel.threadId === undefined ? "" : `, топик ${channel.threadId}`}`);
  }

  /**
   * `/remote vacuum [--dry-run]` — принудительная очистка старых журналов (033).
   *
   * Оставляем последние `keep` (5) ротированных файлов на каждый журнал;
   * `--dry-run` только показывает, что было бы удалено.
   */
  async function vacuumCommand(invocation, flags) {
    const dir = typeof store?.paths?.dir === "string" ? store.paths.dir : null;
    if (dir === null) return failure("хранилище не найдено: сначала /remote connect");
    const dryRun = flags?.has?.("dry-run") === true;
    const result = vacuum(fs, { dir, keep: DEFAULT_KEEP, dryRun, log: (message) => log(message) });
    const size = (bytes) => `${(bytes / 1024).toFixed(1)} КБ`;
    const lines = [];
    if (result.removed.length === 0) {
      lines.push(dryRun ? "удалять нечего: старых журналов нет" : "очистка не требуется: старых журналов нет");
    } else if (dryRun) {
      lines.push(`--dry-run: будет удалено ${result.removed.length} файлов (${size(result.freedBytes)}):`);
      lines.push(...result.removed.map((item) => `  ${path.basename(item.path)} — ${size(item.size)}`));
    } else {
      lines.push(`удалено ${result.removed.length} файлов, освобождено ${size(result.freedBytes)}:`);
      lines.push(...result.removed.map((item) => `  ${path.basename(item.path)} — ${size(item.size)}`));
    }
    lines.push(`оставлено ротированных файлов: ${result.kept.length} (keep=${DEFAULT_KEEP})`);
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
      return failure("метрики недоступны: плагин без фичи metrics (031)");
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
      log(`stats: размеры очередей не прочитаны (${humanError(error)})`);
    }
    const base = metrics.snapshot();
    const snapshot = { ...base, queues: { ...base.queues, ...live } };
    if (flags?.has?.("json") === true) return success(JSON.stringify(snapshot));
    return success(formatStats(snapshot));
  }

  /**
   * `/remote doctor [--json]` — диагностика 2.0 (задача 030).
   *
   * Legacy-проверки 010 остаются (токен, getMe, поллеры, канал, состояние), к ним
   * добавляются credentials/relay/schema/timers; человеческий вывод узнаваем,
   * `--json` — стабильная машиночитаемая структура с кодом возврата.
   */
  async function doctor(invocation, flags) {
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
    });
    const report = buildReport(checks);
    if (flags?.has?.("json") === true) {
      return { ...success(serializeReport(report)), exitCode: report.exitCode };
    }
    return { ...success(formatHealthReport(report)), exitCode: report.exitCode };
  }

  async function disconnect(invocation) {
    const confirm = await askStep(invocation, {
      id: "remote-disconnect-confirm",
      question: "Отвязать бота и выключить удалённый режим?",
      options: ["Да, отвязать", "Нет"],
    });
    if (!/^Да/i.test(confirm.selected[0] ?? "")) return success("отключение отменено");

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
      return failure(`не удалось очистить привязку: ${humanError(error)}`);
    }

    const activeRef = tokenRefFor(activeTransport);
    const described = await credentials.describe(activeRef);
    let secretNote = `секрет ${activeRef} оставлен`;
    if (described.present && described.writable) {
      secretNote = (await credentials.unset(activeRef))
        ? `секрет ${activeRef} удалён`
        : `секрет ${activeRef} удалить не удалось — удалите вручную`;
    } else if (described.present) {
      secretNote = `секрет ${activeRef} из окружения — удалите переменную сами`;
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
          log(`канал ${channel.id ?? "?"}.stop: ${humanError(error)}`);
        }
      }
      try {
        registry.clear?.();
      } catch (error) {
        log(`реестр каналов не очищен: ${humanError(error)}`);
      }
    }

    return success([
      `привязка (${transportLabel(activeTransport)}) удалена, режим выключен`,
      secretNote,
    ].join("\n"));
  }

  /** Обработчик `/remote`: разбор и диспетчеризация. */
  async function handler(invocation) {
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
          return success(HELP_TEXT);
        default:
          return success(`неизвестная подкоманда «${subcommand}»\n\n${HELP_TEXT}`);
      }
    } catch (error) {
      // Сюда попадают отказы userQuestions (человек закрыл вопрос) и прочее:
      // человек должен увидеть текст, а не стек.
      return failure(`/remote ${subcommand}: ${humanError(error)}`);
    }
  }

  const definition = {
    name: "remote",
    description: "удалённое управление вопросами: connect | on | off | status | test | who | disconnect",
    input: { hint: "connect|on|off|status|test|who|disconnect" },
    recordInput: false,
    handler,
  };

  /** Зарегистрировать `/remote` в реестре команд DSH. */
  function register() {
    const commands = serviceOf(ctx, "commands");
    if (typeof commands?.register !== "function") {
      log("команды: ctx.commands недоступен — /remote не зарегистрирован");
      return () => {};
    }
    return commands.register(definition) ?? (() => {});
  }

  return { register, handler, definition };
}
