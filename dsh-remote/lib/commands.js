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
import { fileURLToPath } from "node:url";

import { createRegistry } from "./domain/registry.js";
import { credentialRef, createCredentialAccess } from "./store.js";

/** Имя ссылки на токен Telegram в `ctx.credentials` (не значение!). */
export const TELEGRAM_TOKEN_REF = credentialRef("DSH_REMOTE_TELEGRAM_TOKEN");

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
  "  /remote status     — привязка, режим, источник токена",
  "  /remote test       — отправить тестовый вопрос в мессенджер",
  "  /remote who        — сессия, воркспейс и эффективный режим",
  "  /remote doctor     — проверка привязки, канала и состояния (ok/warn/fail)",
  "  /remote channel <проект> <chatId> [threadId] — канал проекта (топик форума)",
  "    --force          — если бот действительно в другом чате (чужой чат иначе отвергается)",
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
  let token = null;
  const access = credentials;
  if (access === null || typeof access?.availableFor !== "function") {
    add("fail", "токен", "ctx.credentials недоступен", "задайте секрет или токен в окружении");
  } else if (!access.availableFor(TELEGRAM_TOKEN_REF)) {
    add("fail", "токен", `нет ссылки ${TELEGRAM_TOKEN_REF}`, "получите токен у @BotFather и выполните /remote connect");
  } else {
    try {
      token = await access.resolve(TELEGRAM_TOKEN_REF);
    } catch {
      token = null;
    }
    if (typeof token !== "string" || token === "") {
      add("fail", "токен", `${TELEGRAM_TOKEN_REF} не разрешился`, "проверьте секрет: /remote connect");
      token = null;
    } else {
      const info = typeof access.describe === "function" ? await access.describe(TELEGRAM_TOKEN_REF).catch(() => null) : null;
      const source = typeof info?.source === "string" ? info.source : "unknown";
      const readonly = info?.writable === false ? ", только чтение" : "";
      add("ok", "токен", `${TELEGRAM_TOKEN_REF} найден (источник: ${source}${readonly})`);
    }
  }

  // --- getMe ---------------------------------------------------------------
  if (token !== null && typeof telegramCallImpl === "function") {
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
  } else if (token !== null) {
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
  const flags = new Set(parts.slice(1).filter((part) => part.startsWith("--"))
    .map((part) => part.slice(2).toLowerCase()));
  return {
    subcommand: parts[0].toLowerCase(),
    flags,
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
    const service = ctx?.userQuestions;
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

  /** `/remote connect` — пошаговая привязка бота. */
  async function connect(invocation) {
    if (!credentials.availableFor(TELEGRAM_TOKEN_REF)) {
      return failure(`токен неоткуда взять: нет ctx.credentials и нет переменной ${TELEGRAM_TOKEN_REF}`);
    }
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
      const transportAnswer = await askStep(invocation, {
        id: "remote-connect-transport",
        question: "Какой транспорт подключить?",
        options: ["Telegram", "MAX (пока недоступен)"],
      });
      if (transportAnswer.selected[0]?.startsWith("MAX") === true) {
        return failure("MAX пока не поддерживается (фаза 2) — выберите Telegram");
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
      try {
        store.update((state) => {
          state.bindings = {
            transport: "telegram",
            chatId: match.chatId,
            userId: match.userId,
            botUsername,
            createdAt: now(),
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
      lines.push(`бот: @${state.bindings.botUsername ?? "?"} (${state.bindings.transport}), чат ${state.bindings.chatId}, человек ${state.bindings.userId}, привязан ${created}`);
    }

    const described = await credentials.describe(TELEGRAM_TOKEN_REF);
    if (described.source === null) {
      lines.push(`секрет: ${TELEGRAM_TOKEN_REF} — не найден`);
    } else {
      lines.push(`секрет: ${TELEGRAM_TOKEN_REF} — источник ${described.source}${described.writable ? " (запись разрешена)" : " (только чтение)"}`);
    }

    lines.push(`режим: глобально ${state.enabled.global ? "вкл" : "выкл"}; проект ${cwd === null ? "?" : cwd} ${cwd !== null && state.enabled.workspaces[cwd] === true ? "вкл" : "выкл"}; сессия ${sessionId === null ? "?" : sessionId} ${sessionId !== null && state.enabled.sessions[sessionId] === true ? "вкл" : "выкл"}`);
    lines.push(describeEffective(registry.resolve({ sessionId, workspace: cwd })));

    const channels = Object.entries(state.channels ?? {});
    if (channels.length === 0) {
      lines.push("каналы проектов: нет — все вопросы идут в общий чат");
    } else {
      for (const [name, channel] of channels) {
        lines.push(`канал ${name}: чат ${channel.chatId}${channel.threadId === undefined ? "" : `, топик ${channel.threadId}`}`);
      }
    }

    const lock = store.lockState();
    lines.push(lock.held ? `поллер: занят (pid ${lock.holder?.pid ?? "?"})` : "поллер: свободен");

    return success(lines.join("\n"));
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
  function channelCommand(invocation, flags, rest) {
    // rest — аргументы после подкоманды: `list` | `remove <проект>` |
    // `<проект> <chatId> [threadId]`.
    const args = Array.isArray(rest) ? rest : [];
    const [action, target, threadIdRaw] = args;

    if (action === "list" || action === undefined) {
      const channels = Object.entries(store.read().channels ?? {});
      if (channels.length === 0) return success("каналы проектов не заданы: все вопросы идут в общий чат");
      return success(channels.map(([name, channel]) => `${name} → чат ${channel.chatId}${channel.threadId === undefined ? "" : `, топик ${channel.threadId}`}`).join("\n"));
    }

    if (action === "remove") {
      if (typeof target !== "string" || target === "") return failure("укажите проект: /remote channel remove <проект>");
      store.removeChannel(target);
      return success(`проект ${target} снова идёт в общий чат`);
    }

    // set: `/remote channel <проект> <chatId> [threadId]`
    const name = action;
    const numericChat = Number(target);
    if (!Number.isInteger(numericChat) || numericChat <= 0) {
      return failure("chatId должен быть целым положительным числом: /remote channel <проект> <chatId>");
    }
    const bindingChat = store.read().bindings?.chatId;
    // Чужой чат: бот может быть в нём не участником, и тогда ответы не придут.
    // Осознанный обход — --force (человек знает, что бот добавлен в чат).
    if (bindingChat !== undefined && bindingChat !== null && String(bindingChat) !== String(numericChat) && !flags.has("force")) {
      return failure(`чат ${numericChat} не совпадает с привязанным (${bindingChat}): это чужой чат. `
        + "Если бот действительно добавлен туда, повторите с --force");
    }
    const numericThread = Number(threadIdRaw);
    const channel = {
      chatId: numericChat,
      ...(Number.isInteger(numericThread) && numericThread > 0 ? { threadId: numericThread } : {}),
    };
    try {
      store.setChannel(name, channel);
    } catch (error) {
      return failure(`канал не сохранён: ${humanError(error)}`);
    }
    return success(`проект ${name} → чат ${channel.chatId}${channel.threadId === undefined ? "" : `, топик ${channel.threadId}`}`);
  }

  /** `/remote doctor` — диагностика: токен, getMe, поллеры, канал, состояние. */
  async function doctor() {
    const checks = await runDoctorChecks({
      store,
      credentials,
      transport: liveTransport(),
      telegramCallImpl: (token, method) => telegramCall(token, method),
      version: readPluginVersion(),
      now,
    });
    return success(formatDoctorReport(checks));
  }

  async function disconnect(invocation) {
    const confirm = await askStep(invocation, {
      id: "remote-disconnect-confirm",
      question: "Отвязать бота и выключить удалённый режим?",
      options: ["Да, отвязать", "Нет"],
    });
    if (!/^Да/i.test(confirm.selected[0] ?? "")) return success("отключение отменено");

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

    const described = await credentials.describe(TELEGRAM_TOKEN_REF);
    let secretNote = `секрет ${TELEGRAM_TOKEN_REF} оставлен`;
    if (described.present && described.writable) {
      secretNote = (await credentials.unset(TELEGRAM_TOKEN_REF))
        ? `секрет ${TELEGRAM_TOKEN_REF} удалён`
        : `секрет ${TELEGRAM_TOKEN_REF} удалить не удалось — удалите вручную`;
    } else if (described.present) {
      secretNote = `секрет ${TELEGRAM_TOKEN_REF} из окружения — удалите переменную сами`;
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

    return success(`привязка удалена, режим выключен\n${secretNote}`);
  }

  /** Обработчик `/remote`: разбор и диспетчеризация. */
  async function handler(invocation) {
    const { subcommand, flags, rest } = parseRemoteArgs(invocation?.rawInput);
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
        case "test":
          return await testChannel(invocation);
        case "who":
          return who(invocation);
        case "doctor":
          return await doctor();
        case "channel":
          return channelCommand(invocation, flags, rest);
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
    const commands = ctx?.commands ?? ctx?.get?.("commands") ?? null;
    if (typeof commands?.register !== "function") {
      log("команды: ctx.commands недоступен — /remote не зарегистрирован");
      return () => {};
    }
    return commands.register(definition) ?? (() => {});
  }

  return { register, handler, definition };
}
