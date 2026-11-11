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

/** Словари. Ключи обязаны совпадать (проверяется тестом). */
export const dictionaries = Object.freeze({
  ru: Object.freeze({
    "present.freeTextLabel": "Другой ответ…",
    "present.freeTextHint": "↩︎ Ответьте текстом на это сообщение.",
    "present.quickReplyHint": "↩︎ Или ответьте текстом на это сообщение.",
    "present.moreLabel": "Показать ещё",
    "present.multiselectHint": "Можно выбрать несколько вариантов.",
    "present.truncationMarker": "…обрезано",
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
    "commands.helpFooter": "  /remote help       — эта справка",

    "commands.lang.current": "язык: {lang}",
    "commands.lang.set": "язык переключён: {lang}",
    "commands.lang.usage": "usage: /remote lang ru|en",
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
    "commands.status.notBound": "бот не привязан: /remote connect",
    "commands.status.secret": "секрет: {ref} — не найден",
    "commands.status.hybrid": "гибрид: {state}",
    "commands.status.mode": "режим: {scope}",
    "commands.status.effective": "эффективно: {state}",
    "commands.status.approvals": "approvals: политика не загружена — удалённые подтверждения только в GUI",
  }),
  en: Object.freeze({
    "present.freeTextLabel": "Other answer…",
    "present.freeTextHint": "↩︎ Reply to this message with text.",
    "present.quickReplyHint": "↩︎ Or reply with text to this message.",
    "present.moreLabel": "Show more",
    "present.multiselectHint": "You can select multiple options.",
    "present.truncationMarker": "…truncated",
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
    "commands.helpFooter": "  /remote help       — this help",

    "commands.lang.current": "language: {lang}",
    "commands.lang.set": "language switched: {lang}",
    "commands.lang.usage": "usage: /remote lang ru|en",
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
    "commands.status.notBound": "bot is not bound: /remote connect",
    "commands.status.secret": "secret: {ref} — not found",
    "commands.status.hybrid": "hybrid: {state}",
    "commands.status.mode": "mode: {scope}",
    "commands.status.effective": "effective: {state}",
    "commands.status.approvals": "approvals: policy not loaded — remote approvals only in GUI",
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
