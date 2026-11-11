/**
 * Быстрые ответы для вопросов без вариантов (задача 044).
 *
 * Человеку не нужно печатать текст: в мессенджере появляются кнопки частых
 * решений. Нажатие возвращается в сессию как свободный ответ (`custom`) с
 * человекочитаемым текстом, поэтому модель понимает смысл без знания схемы.
 *
 * Набор настраивается в конфиге плагина (`quickReplies: [{label, text}]`);
 * пустой массив выключает кнопки — тогда работает обычный ввод текста.
 */

/** Четыре решения по умолчанию. */
import { DEFAULT_LANG, normalizeLang, t } from "./i18n.js";

/** Четыре решения по умолчанию (подписи — из словаря языка). */
export function defaultQuickReplies(lang = DEFAULT_LANG) {
  const code = normalizeLang(lang) ?? DEFAULT_LANG;
  return [
    { id: "q1", label: t("present.quickYes", {}, code), text: t("present.quickYes", {}, code) },
    { id: "q2", label: t("present.quickNo", {}, code), text: t("present.quickNo", {}, code) },
    { id: "q3", label: t("present.quickLater", {}, code), text: t("present.quickLaterText", {}, code) },
    { id: "q4", label: t("present.quickDelegate", {}, code), text: t("present.quickDelegateText", {}, code) },
  ];
}

/** Предел числа кнопок: больше всё равно не влезет в один экран. */
const MAX_QUICK_REPLIES = 8;

const trim = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Нормализовать набор: `[{id,label,text}]`.
 *
 * - `undefined`/`null` — набор по умолчанию;
 * - пустой массив — кнопок нет (выключено);
 * - не-массив/битые записи — безопасный дефолт (не теряем возможность ответить);
 * - id стабильны (`q1…`) и не пересекаются с вариантами (`o1…`).
 */
export function normalizeQuickReplies(value, lang = DEFAULT_LANG) {
  if (value === undefined || value === null) return defaultQuickReplies(lang);
  if (!Array.isArray(value)) return defaultQuickReplies(lang);
  if (value.length === 0) return [];

  const normalized = [];
  for (const item of value) {
    const label = trim(item?.label);
    const text = trim(item?.text);
    if (label === "" || text === "") continue;
    normalized.push({ id: `q${normalized.length + 1}`, label, text });
    if (normalized.length >= MAX_QUICK_REPLIES) break;
  }
  // Набор задан, но все записи битые: не оставляем человека без кнопок и без
  // подсказки — откатываемся к дефолту.
  if (normalized.length === 0) return defaultQuickReplies(lang);
  return normalized;
}
