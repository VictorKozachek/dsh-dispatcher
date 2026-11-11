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
export const DEFAULT_QUICK_REPLIES = Object.freeze([
  Object.freeze({ label: "Да", text: "Да" }),
  Object.freeze({ label: "Нет", text: "Нет" }),
  Object.freeze({ label: "Отложить", text: "Отложить, вернёмся позже" }),
  Object.freeze({ label: "Решай сам", text: "Реши сам, я делегирую" }),
]);

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
export function normalizeQuickReplies(value) {
  if (value === undefined || value === null) {
    return DEFAULT_QUICK_REPLIES.map((item, index) => ({ id: `q${index + 1}`, label: item.label, text: item.text }));
  }
  if (!Array.isArray(value)) {
    return DEFAULT_QUICK_REPLIES.map((item, index) => ({ id: `q${index + 1}`, label: item.label, text: item.text }));
  }
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
  if (normalized.length === 0) {
    return DEFAULT_QUICK_REPLIES.map((item, index) => ({ id: `q${index + 1}`, label: item.label, text: item.text }));
  }
  return normalized;
}
