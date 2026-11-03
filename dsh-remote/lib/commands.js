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
  "  /remote disconnect — отвязать бота и выключить режим",
].join("\n");

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
} = {}) {
  const registry = createRegistry({ readState: () => store.read().enabled, log });
  const credentials = createCredentialAccess(ctx, { log });

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
      if (transport === null) transport = ctx?.get?.("remoteTransport") ?? null;
      if (typeof transport?.start === "function") {
        try {
          await transport.start();
          channelNote = "канал поднят: вопросы уходят в мессенджер";
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
  function setMode(invocation, enabled, flags) {
    const { sessionId, cwd } = sessionInfo(invocation);
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

    if (state.bindings === null) {
      lines.push("бот не привязан: /remote connect");
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

    const lock = store.lockState();
    lines.push(lock.held ? `поллер: занят (pid ${lock.holder?.pid ?? "?"})` : "поллер: свободен");

    return success(lines.join("\n"));
  }

  /** `/remote test` — отправить тестовый вопрос через живой транспорт. */
  async function testChannel(invocation) {
    const state = store.read();
    if (state.bindings === null) return failure("бот не привязан: /remote connect");
    const transport = ctx?.get?.("remoteTransport") ?? null;
    if (transport === null || typeof transport.sendQuestion !== "function") {
      return failure("транспорт не поднят: проверьте привязку и токен (/remote status)");
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
    try {
      if (typeof transport.onAnswer === "function") {
        off = transport.onAnswer((event) => {
          if (event?.shortId !== shortId) return;
          off?.();
          off = null;
          void transport.closeQuestion?.(question, "тест пройден");
        });
      }
      await transport.sendQuestion(question);
    } catch (error) {
      off?.();
      off = null;
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

    return success(`привязка удалена, режим выключен\n${secretNote}`);
  }

  /** Обработчик `/remote`: разбор и диспетчеризация. */
  async function handler(invocation) {
    const { subcommand, flags } = parseRemoteArgs(invocation?.rawInput);
    try {
      switch (subcommand) {
        case "connect":
          return await connect(invocation);
        case "on":
          return setMode(invocation, true, flags);
        case "off":
          return setMode(invocation, false, flags);
        case "status":
          return await status(invocation);
        case "test":
          return await testChannel(invocation);
        case "who":
          return who(invocation);
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
