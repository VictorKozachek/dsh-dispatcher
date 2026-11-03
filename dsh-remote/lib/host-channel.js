/**
 * Host-канал панели: RPC-служба `remotePanel` для клиентской половины.
 *
 * Зачем канал: состояние и журнал лежат в `~/.dsh/remote-control/`, то есть
 * **вне** рабочей директории сессии, а клиентская половина умеет читать только
 * воркспейс (`workspaceFiles` — read-only Remote). Поэтому читает хост, а
 * браузер получает уже очищенный снимок.
 *
 * Механика — та же, что у `dsh-kanban/lib/card-actions.js` (задача #047):
 * cordis-служба кладётся в контекст под ключом `remotePanel` и помечается
 * рантайм-маркерами Typert (`typertRemote` + дескриптор
 * `@deepseek-ai/dsh-typert-protocol/remote-methods` версии 1). Gateway находит
 * endpoint в SRC-режиме и разбирает имена параметров обычного JS-метода, поэтому
 * у методов ровно один простой параметр `request` (без деструктуризации,
 * значений по умолчанию и rest).
 *
 * Пакет `@deepseek-ai/dsh-typert-protocol` из плагина не резолвится (профиль
 * монтирует плагин симлинком, а рядом нет node_modules), поэтому markers
 * строятся по опубликованной рантайм-форме, а не импортом — это тот же
 * wire-контракт, что у типизированных remote'ов.
 *
 * Безопасность: клиент присылает только `{}` (снимок) или `{shortId}` (снятие).
 * Никаких путей, команд и параметров записи — канал не может ничего выполнить.
 */

import { defaultPaths, panelSnapshot } from "./panel.js";

/** Ключ контекста и namespace Remote-службы: endpoint — `<namespace>/<method>`. */
export const SERVICE_KEY = "remotePanel";
export const NAMESPACE = "remotePanel";

/** Ключ дескриптора Remote-методов на прототипе службы (контракт протокола). */
export const REMOTE_METHODS_KEY = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/** `shortId` вопроса: 8 шестнадцатеричных символов (см. 002). */
export const SHORT_ID_PATTERN = /^[0-9a-f]{8}$/;

/** Предел текста ответа: баннер в GUI не должен разрастаться. */
const MAX_MESSAGE = 400;

/** Одна строка для GUI. */
function shortText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= MAX_MESSAGE) return text;
  return `${text.slice(0, MAX_MESSAGE - 1)}…`;
}

/** Простой объект: пришедший по проводу запрос не должен тащить классы/массивы. */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Проверить запрос из GUI.
 *
 * Для снимка допустим только пустой объект (панель не спрашивает ничего
 * приватного), для снятия — `{shortId}`. Лишние поля отвергаются: это отсекает
 * попытку протащить путь или «команду».
 *
 * @param request - присланный объект.
 * @param allowed - список допустимых полей.
 * @returns `{ok: true, value}` или `{ok: false, message}`.
 */
export function validateRequest(request, allowed = []) {
  if (!isPlainObject(request)) return { ok: false, message: "ожидался объект запроса" };
  const extra = Object.keys(request).filter((key) => !allowed.includes(key));
  if (extra.length > 0) return { ok: false, message: `лишние поля в запросе: ${extra.join(", ")}` };
  const value = {};
  for (const key of allowed) {
    if (request[key] === undefined) continue;
    if (typeof request[key] !== "string") return { ok: false, message: `поле ${key} должно быть строкой` };
    value[key] = request[key].trim();
  }
  if (allowed.includes("shortId")) {
    if (!SHORT_ID_PATTERN.test(value.shortId ?? "")) {
      return { ok: false, message: "неверный shortId: ожидаются 8 шестнадцатеричных символов" };
    }
  }
  return { ok: true, value };
}

/**
 * Пометить метод службы как Remote для Gateway (SRC-режим).
 *
 * @param prototype - прототип класса службы.
 * @param method - имя публичного метода.
 */
export function markRemoteMethod(prototype, method) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHODS_KEY)?.value;
  const methods = Array.isArray(descriptor?.methods) ? [...descriptor.methods] : [];
  if (!methods.some((entry) => entry.method === method)) {
    methods.push(Object.freeze({ method, invocation: Object.freeze({ kind: "direct" }) }));
  }
  Object.defineProperty(prototype, REMOTE_METHODS_KEY, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze(methods) }),
  });
}

/**
 * Служба панели.
 *
 * Методы — обычные `async` с одним простым параметром `request`: этого требует
 * SRC-режим Gateway.
 */
export class PanelService {
  /** @param options - `{stateFile, logFile, settings, channelPresent, now, logger}`. */
  constructor(options) {
    this.options = options;
  }

  /** Снимок статуса, открытых вопросов и хвоста журнала. */
  async snapshot(request) {
    const checked = validateRequest(request, []);
    if (!checked.ok) return checked;
    try {
      return panelSnapshot({
        stateFile: this.options.stateFile,
        logFile: this.options.logFile,
        settings: this.options.settings,
        channelPresent: this.options.channelPresent === true,
        now: this.options.now,
        logger: this.options.logger,
      });
    } catch (error) {
      return { ok: false, message: shortText(`снимок не собран: ${error?.message ?? error}`) };
    }
  }

  /**
   * Снять вопрос.
   *
   * В этой сборке снятие делает host-половина reliability (008): если сервис
   * `remoteReliability` есть и умеет `dismiss`, зовём его. Иначе честно
   * говорим «только чтение» — панель не должна делать вид, что сняла вопрос.
   */
  async dismiss(request) {
    const checked = validateRequest(request, ["shortId"]);
    if (!checked.ok) return checked;
    const { shortId } = checked.value;
    const reliability = this.options.reliability?.();
    if (reliability !== null && typeof reliability?.dismiss === "function") {
      try {
        const result = await reliability.dismiss({ shortId });
        return { ok: result === true || result?.ok === true, shortId, message: "" };
      } catch (error) {
        return { ok: false, shortId, message: shortText(`снять не удалось: ${error?.message ?? error}`) };
      }
    }
    return {
      ok: false,
      shortId,
      readonly: true,
      message: shortText("снять вопрос из панели нельзя в этой сборке: /remote status в сессии"),
    };
  }

  /** Отправить тестовый вопрос в канал (если он поднят). */
  async test(request) {
    const checked = validateRequest(request, []);
    if (!checked.ok) return checked;
    const transport = this.options.transport?.();
    if (transport === null || typeof transport?.sendQuestion !== "function") {
      return {
        ok: false,
        readonly: true,
        message: shortText("канал не поднят: привяжите бота командой /remote connect"),
      };
    }
    try {
      await transport.sendQuestion({
        shortId: String(Date.now()).slice(-8),
        title: "Тест из панели",
        body: "Проверка канала dsh-remote. Нажмите любую кнопку.",
        options: [{ id: "ok", label: "Ок" }],
      });
      return { ok: true, message: "тестовый вопрос отправлен" };
    } catch (error) {
      return { ok: false, message: shortText(`отправить не удалось: ${error?.message ?? error}`) };
    }
  }
}

markRemoteMethod(PanelService.prototype, "snapshot");
markRemoteMethod(PanelService.prototype, "dismiss");
markRemoteMethod(PanelService.prototype, "test");

/**
 * Зарегистрировать канал в host-контексте плагина.
 *
 * @param ctx - cordis-контекст (host-половина).
 * @param options - `{settings, logger, stateFile?, logFile?, now?}`.
 * @returns `{service, dispose}`: служба (для тестов) и disposer регистрации.
 */
export function registerPanelService(ctx, options = {}) {
  const paths = defaultPaths();
  const service = new PanelService({
    stateFile: options.stateFile ?? paths.stateFile,
    logFile: options.logFile ?? paths.logFile,
    settings: options.settings ?? {},
    now: options.now ?? (() => Date.now()),
    logger: options.logger ?? (() => {}),
    channelPresent: typeof options.channelPresent === "function" ? options.channelPresent() : options.channelPresent === true,
    transport: typeof options.transport === "function" ? options.transport : () => null,
    reliability: typeof options.reliability === "function" ? options.reliability : () => null,
  });
  service.typertRemote = Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: NAMESPACE });

  let dispose = () => {};
  try {
    dispose = ctx?.provide?.(SERVICE_KEY, service) ?? (() => {});
  } catch (error) {
    options.logger?.(`панель: служба ${SERVICE_KEY} не зарегистрирована (${error?.message ?? error})`);
  }
  return { service, dispose };
}
