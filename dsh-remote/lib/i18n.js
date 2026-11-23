/**
 * Локализация RU/EN (задача 046).
 *
 * Переводятся **пользовательские тексты**: сообщения вопроса в мессенджере,
 * ответы команд `/remote`, подписи панели. Не переводятся имена команд и полей,
 * `callback_data`, названия инструментов и тексты ошибок внешних API.
 *
 * Словари плоские (`section.key`), чтобы тест полноты сравнивал наборы ключей
 * один-в-один. Подстановка — `{name}`, неизвестный ключ возвращает сам ключ и не
 * бросает: локализация не должна ломать вывод.
 */

/** Поддерживаемые языки. */
export const LANGS = Object.freeze(["ru", "en"]);

/** Язык по умолчанию. */
export const DEFAULT_LANG = "ru";

import { COMMAND_MESSAGES_EN, COMMAND_MESSAGES_RU } from "./i18n-commands.js";
import {
  DOCTOR_MESSAGES_EN,
  DOCTOR_MESSAGES_RU,
  METRICS_MESSAGES_EN,
  METRICS_MESSAGES_RU,
  POLICY_MESSAGES_EN,
  POLICY_MESSAGES_RU,
} from "./i18n-modules.js";

/** Базовые словари (сообщения, панель, help/status). */
const dictionariesBase = Object.freeze({
  ru: Object.freeze({
    "present.freeTextLabel": "Другой ответ…",
    "present.freeTextHint": "↩︎ Ответьте текстом на это сообщение.",
    "present.mirrorNotifyHint": "🪞 Ответьте в GUI (или нажмите кнопку) — это сообщение-уведомление.",
    "present.quickReplyHint": "↩︎ Или ответьте текстом на это сообщение.",
    "present.moreLabel": "Показать ещё",
    "present.multiselectHint": "Можно выбрать несколько вариантов.",
    "present.truncationMarker": "…обрезано",
    "present.buttonHint": "👆 Нажмите кнопку ниже.",
    "present.moreLines.one": "…ещё {count} строка",
    "present.moreLines.few": "…ещё {count} строки",
    "present.moreLines.many": "…ещё {count} строк",
    "present.emptyQuestion": "(пустой вопрос)",
    "present.questionOf": "вопрос {index}/{total}",
    "present.task": "task {id}",
    "present.until": "до {time}",
    "present.approvalTitle": "Подтверждение действия",
    "present.quickYes": "Да",
    "present.quickNo": "Нет",
    "present.quickLater": "Отложить",
    "present.quickDelegate": "Решай сам",
    "present.quickLaterText": "Отложить, вернёмся позже",
    "present.quickDelegateText": "Реши сам, я делегирую",

    "commands.helpTitle": "Команды /remote:",
    "commands.helpConnect": "  /remote connect    — привязать бота (пошагово, локальными вопросами)",
    "commands.helpOnOff": "  /remote on|off     — включить/выключить для этого проекта",
    "commands.helpAll": "    --all            — для всех проектов, --session — только для этой сессии",
    "commands.helpHybrid": "    --hybrid         — гибрид: вопрос уходит в GUI, если в мессенджере молчат N секунд",
    "commands.helpStatus": "  /remote status     — состояние: канал, привязка, режим",
    "commands.helpDoctor": "  /remote doctor [--json] — проверка привязки, канала и состояния (ok/warn/fail)",
    "commands.helpStats": "  /remote stats [--json] — метрики: вопросы, подтверждения, доставки, латентность, очереди",
    "commands.helpVacuum": "  /remote vacuum [--dry-run] — очистить старые ротированные журналы",
    "commands.helpLang": "  /remote lang ru|en — язык сообщений (без аргумента — текущий)",
    "commands.helpApprovals": "  /remote approvals [allow|deny <tool>] [--force] — политика подтверждений",
    "commands.helpReload": "  /remote reload — перечитать present/i18n без перезапуска",
    "commands.helpFooter": "  /remote help       — эта справка",

    "commands.lang.current": "язык: {lang}",
    "commands.lang.set": "язык переключён: {lang}",
    "commands.lang.usage": "usage: /remote lang ru|en",
    "commands.connect.approvalsQuestion": "Присылать подтверждения опасных действий (запуск команд, запись файлов, git push) в мессенджер? «Да, всё» разрешает подтверждать выполнение команд с телефона.",
    "commands.connect.approvalsAll": "Да, всё",
    "commands.connect.approvalsSafe": "Только безопасные (по умолчанию)",
    "commands.connect.approvalsGuiOnly": "Всё только в GUI",
    "commands.approvals.modeSet": "режим подтверждений: {p0}",
    "commands.approvals.modeWarning": "ВНИМАНИЕ: режим all разрешает подтверждать запуск команд и запись файлов с телефона.",
    "commands.approvals.modeUsage": "usage: /remote approvals mode safe|all|gui-only",
    "commands.reload.ok": "present/i18n перечитаны из диска",
    "commands.approvals.usage": "usage: /remote approvals [allow|deny <tool>] [--force]",
    "commands.approvals.title": "Политика подтверждений (state.json, действует сразу):",
    "commands.approvals.last": "Последнее решение: {p0} → {p1} (decision: {p2})",
    "commands.approvals.none": "последнего решения ещё нет",
    "commands.approvals.allowed": "{p0}: разрешён удалённо; denyRemote снят. Дефолт для остальных не менялся.",
    "commands.approvals.denied": "{p0}: возвращён в GUI (denyRemote).",
    "commands.approvals.force": "{tool} опасен: удалённое подтверждение требует явного --force (вы разрешаете выполнение без проверки за компьютером).",
    "commands.approvals.warnDanger": "Внимание: {p0} теперь можно подтвердить с телефона — команды выполнятся без проверки человеком за компьютером.",
    "commands.approvals.unknown": "неизвестное действие approvals: {value}",
    "commands.approvals.unavailable": "политика подтверждений не загружена",
    "commands.status.approvalsLast": "approvals: последнее решение {tool} → {reason} ({decision})",
    "commands.lang.unknown": "неизвестный язык: {value} (доступны: ru, en)",
    "commands.helpNoHybrid": "    --no-hybrid      — выключить гибридный режим",
    "commands.helpStatusLong": "  /remote status     — привязка, режим, источник токена",
    "commands.helpAudit": "  /remote audit [N]  — последние N решений по подтверждениям (по умолчанию 20)",
    "commands.helpTest": "  /remote test       — отправить тестовый вопрос в мессенджер",
    "commands.helpWho": "  /remote who        — сессия, воркспейс и эффективный режим",
    "commands.helpChannel": "  /remote channel <проект> <chatId> [threadId] — канал проекта (топик форума)",
    "commands.helpForce": "    --force          — если бот действительно в другом чате (чужой чат иначе отвергается)",
    "commands.helpTransport": "    --transport=<id> — канал для конкретного канала (telegram, max); по умолчанию — транспорт привязки",
    "commands.helpChannelList": "  /remote channel list — какие каналы у каких проектов",
    "commands.helpChannelRemove": "  /remote channel remove <проект> — вернуть проект в общий чат",
    "commands.helpDisconnect": "  /remote disconnect — отвязать бота и выключить режим",
    "commands.unknownSubcommand": "неизвестная подкоманда «{name}»",


    "commands.status.language": "язык: {lang}",
    "commands.status.journal": "журнал: {p0}",
    "commands.status.override": "режим: глобально {p0}; {p1} → {p2} (scope: {p3})",
    "commands.status.journalDisabled": "журнал выключен: {p0}",
    "commands.status.notBound": "бот не привязан: /remote connect",
    "commands.status.secret": "секрет: {ref} — не найден",
    "commands.status.hybrid": "гибрид: {state}",
    "commands.status.mirror": "mirror: {p0}{p1}",
    "commands.status.mode": "режим: {scope}",
    "commands.status.effective": "эффективно: {state}",
    "commands.status.approvals": "approvals: политика не загружена — удалённые подтверждения только в GUI",
  }),
  en: Object.freeze({
    "present.freeTextLabel": "Other answer…",
    "present.freeTextHint": "↩︎ Reply to this message with text.",
    "present.mirrorNotifyHint": "🪞 Answer in the GUI (or tap a button) — this message is a notification.",
    "present.quickReplyHint": "↩︎ Or reply with text to this message.",
    "present.moreLabel": "Show more",
    "present.multiselectHint": "You can select multiple options.",
    "present.truncationMarker": "…truncated",
    "present.buttonHint": "👆 Tap a button below.",
    "present.moreLines.one": "…{count} more line",
    "present.moreLines.few": "…{count} more lines",
    "present.moreLines.many": "…{count} more lines",
    "present.emptyQuestion": "(empty question)",
    "present.questionOf": "question {index}/{total}",
    "present.task": "task {id}",
    "present.until": "until {time}",
    "present.approvalTitle": "Action approval",
    "present.quickYes": "Yes",
    "present.quickNo": "No",
    "present.quickLater": "Later",
    "present.quickDelegate": "You decide",
    "present.quickLaterText": "Later, let's come back to this",
    "present.quickDelegateText": "You decide, I delegate",

    "commands.helpTitle": "/remote commands:",
    "commands.helpConnect": "  /remote connect    — bind a bot (step by step, local questions)",
    "commands.helpOnOff": "  /remote on|off     — enable/disable for this project",
    "commands.helpAll": "    --all            — for all projects, --session — only this session",
    "commands.helpHybrid": "    --hybrid         — hybrid: hand the question to the GUI after N seconds",
    "commands.helpStatus": "  /remote status     — channel, binding, mode",
    "commands.helpDoctor": "  /remote doctor [--json] — checks for binding, channel and state (ok/warn/fail)",
    "commands.helpStats": "  /remote stats [--json] — metrics: questions, approvals, deliveries, latency, queues",
    "commands.helpVacuum": "  /remote vacuum [--dry-run] — remove old rotated journals",
    "commands.helpLang": "  /remote lang ru|en — message language (no argument — current)",
    "commands.helpApprovals": "  /remote approvals [allow|deny <tool>] [--force] — approval policy",
    "commands.helpReload": "  /remote reload — reload present/i18n without restart",
    "commands.helpFooter": "  /remote help       — this help",

    "commands.lang.current": "language: {lang}",
    "commands.lang.set": "language switched: {lang}",
    "commands.lang.usage": "usage: /remote lang ru|en",
    "commands.connect.approvalsQuestion": "Send confirmations of dangerous actions (commands, file writes, git push) to the messenger? «Yes, all» allows approving command execution from the phone.",
    "commands.connect.approvalsAll": "Yes, all",
    "commands.connect.approvalsSafe": "Safe only (default)",
    "commands.connect.approvalsGuiOnly": "GUI only",
    "commands.approvals.modeSet": "approval mode: {p0}",
    "commands.approvals.modeWarning": "WARNING: mode all allows approving command execution and file writes from the phone.",
    "commands.approvals.modeUsage": "usage: /remote approvals mode safe|all|gui-only",
    "commands.reload.ok": "present/i18n reloaded from disk",
    "commands.approvals.usage": "usage: /remote approvals [allow|deny <tool>] [--force]",
    "commands.approvals.title": "Approval policy (state.json, effective immediately):",
    "commands.approvals.last": "Last decision: {p0} → {p1} (decision: {p2})",
    "commands.approvals.none": "no decision yet",
    "commands.approvals.allowed": "{p0}: allowed remotely; denyRemote entry removed. Defaults for other tools unchanged.",
    "commands.approvals.denied": "{p0}: back to GUI (denyRemote).",
    "commands.approvals.force": "{tool} is dangerous: remote approval requires explicit --force (you allow execution without desktop review).",
    "commands.approvals.warnDanger": "Warning: {p0} can now be approved from the phone — commands will run without desktop review.",
    "commands.approvals.unknown": "unknown approvals action: {value}",
    "commands.approvals.unavailable": "approval policy is not loaded",
    "commands.status.approvalsLast": "approvals: last decision {tool} → {reason} ({decision})",
    "commands.lang.unknown": "unknown language: {value} (available: ru, en)",
    "commands.helpNoHybrid": "    --no-hybrid      — disable hybrid mode",
    "commands.helpStatusLong": "  /remote status     — binding, mode, token source",
    "commands.helpAudit": "  /remote audit [N]  — last N approval decisions (default 20)",
    "commands.helpTest": "  /remote test       — send a test question to the messenger",
    "commands.helpWho": "  /remote who        — session, workspace and effective mode",
    "commands.helpChannel": "  /remote channel <project> <chatId> [threadId] — project channel (forum topic)",
    "commands.helpForce": "    --force          — if the bot really is in another chat (foreign chat is rejected otherwise)",
    "commands.helpTransport": "    --transport=<id> — channel for a specific transport (telegram, max); default — binding transport",
    "commands.helpChannelList": "  /remote channel list — which channels belong to which projects",
    "commands.helpChannelRemove": "  /remote channel remove <project> — return the project to the shared chat",
    "commands.helpDisconnect": "  /remote disconnect — unbind the bot and disable the mode",
    "commands.unknownSubcommand": "unknown subcommand «{name}»",


    "commands.status.language": "language: {lang}",
    "commands.status.journal": "journal: {p0}",
    "commands.status.override": "mode: global {p0}; {p1} → {p2} (scope: {p3})",
    "commands.status.journalDisabled": "journal disabled: {p0}",
    "commands.status.notBound": "bot is not bound: /remote connect",
    "commands.status.secret": "secret: {ref} — not found",
    "commands.status.hybrid": "hybrid: {state}",
    "commands.status.mirror": "mirror: {p0}{p1}",
    "commands.status.mode": "mode: {scope}",
    "commands.status.effective": "effective: {state}",
    "commands.status.approvals": "approvals: policy not loaded — remote approvals only in GUI",
  }),
});

/** Словари. Ключи обязаны совпадать (проверяется тестом). */
export const dictionaries = Object.freeze({
  ru: Object.freeze({
    ...dictionariesBase.ru,
    ...COMMAND_MESSAGES_RU,
    ...DOCTOR_MESSAGES_RU,
    ...METRICS_MESSAGES_RU,
    ...POLICY_MESSAGES_RU,
  }),
  en: Object.freeze({
    ...dictionariesBase.en,
    ...COMMAND_MESSAGES_EN,
    ...DOCTOR_MESSAGES_EN,
    ...METRICS_MESSAGES_EN,
    ...POLICY_MESSAGES_EN,
  }),
});

/** Язык поддерживается? Регистр и `ru-RU` нормализуются. */
export function normalizeLang(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase().replace(/_/g, "-").split("-")[0];
  return LANGS.includes(code) ? code : null;
}

/**
 * Выбрать язык: явная настройка → локаль DSH/окружения → `ru`.
 *
 * Явная настройка — `state.lang` (команда `/remote lang`); локаль берём из
 * `DSH_LANG`, `LC_ALL`, `LC_MESSAGES`, `LANG` (первое распознанное значение).
 */
export function resolveLanguage({ explicit = null, env = process.env } = {}) {
  const fromState = normalizeLang(explicit);
  if (fromState !== null) return fromState;
  // Именно локаль DSH/плагина, не общесистемная: иначе `LANG=en_US` менял бы
  // язык сообщений у русскоязычного пользователя без явной настройки.
  for (const name of ["DSH_LANG", "DSH_REMOTE_LANG"]) {
    const resolved = normalizeLang(env?.[name]);
    if (resolved !== null) return resolved;
  }
  return DEFAULT_LANG;
}

/** Подставить `{name}`; неизвестный параметр оставляем как есть, но не бросаем. */
export function formatTemplate(template, params = {}) {
  if (typeof template !== "string") return "";
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (params === null || typeof params !== "object") return match;
    if (!(name in params)) return match;
    const value = params[name];
    return value === null || value === undefined ? "" : String(value);
  });
}

/**
 * Перевод: `t("present.freeTextLabel")`.
 *
 * Неизвестный ключ → сам ключ (без исключения); неизвестный язык → `ru`.
 */
export function t(key, params = {}, lang = DEFAULT_LANG) {
  const code = normalizeLang(lang) ?? DEFAULT_LANG;
  const template = dictionaries[code]?.[key] ?? dictionaries[DEFAULT_LANG]?.[key];
  if (template === undefined) return key;
  return formatTemplate(template, params);
}

/** Переводчик для одного языка: удобно передавать в представление/команды. */
export function translator(lang = DEFAULT_LANG) {
  const code = normalizeLang(lang) ?? DEFAULT_LANG;
  return (key, params) => t(key, params, code);
}


// 079: активный словарь для горячего present.js. /remote reload перезагружает
// этот модуль, и свежий present читает новые тексты через globalThis.
globalThis.__dshRemoteI18n = { t, translator, resolveLanguage, formatTemplate };
