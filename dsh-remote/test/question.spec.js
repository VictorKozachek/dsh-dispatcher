/**
 * Тесты домена вопроса: модель `RemoteQuestion`, ответ и переходы статусов.
 *
 * Ни сети, ни DSH: только объект вопроса и подменённые часы. Лог собирается в
 * массив — на отказы в принятии ответа домен обязан не молчать.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TTL_MS,
  QUESTION_STATUS,
  RemoteQuestion,
  createQuestion,
  createQuestions,
} from "../lib/domain/question.js";

const NOW = 1_000_000;

/** Элемент `AskUserQuestionItem` из запроса DSH. */
function item(overrides = {}) {
  return {
    id: "q1",
    question: "Продолжать деплой?",
    header: "Деплой",
    detail: "Сборка зелёная, тесты прошли",
    options: [{ label: "Да" }, { label: "Нет", description: "Остановиться" }],
    ...overrides,
  };
}

/** Вопрос в статусе `open`: конструктор + отметка отправки. */
function opened(overrides = {}, context = {}) {
  const question = createQuestion(item(overrides), { now: NOW, ...context });
  question.markOpen(NOW);
  return question;
}

test("модель собирается из AskUserQuestionItem", () => {
  const question = createQuestion(item(), { now: NOW, sessionId: "s1", workspace: "/p" });

  assert.match(question.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(question.shortId, /^[0-9a-f]{8}$/, "shortId — 8 hex, влезает в callback_data");
  assert.equal(question.questionId, "q1", "id вызывающего сохраняется для ответа");
  assert.equal(question.sessionId, "s1");
  assert.equal(question.workspace, "/p");
  assert.equal(question.role, null);
  assert.equal(question.taskId, null);
  assert.equal(question.title, "Деплой");
  assert.equal(question.body, "Продолжать деплой?");
  assert.equal(question.detail, "Сборка зелёная, тесты прошли");
  assert.deepEqual(question.options.map((option) => option.id), ["o1", "o2"]);
  assert.deepEqual(question.options.map((option) => option.label), ["Да", "Нет"]);
  assert.equal(question.multiSelect, false);
  assert.equal(question.allowFreeText, true);
  assert.equal(question.createdAt, NOW);
  assert.equal(question.expiresAt, NOW + DEFAULT_TTL_MS);
  assert.equal(question.status, QUESTION_STATUS.pending);
  assert.equal(question.answer, undefined);
});

test("multiSelect и plan-review меняют флаги модели", () => {
  const multi = createQuestion(item({ multiSelect: true }), { now: NOW });
  assert.equal(multi.multiSelect, true);

  const review = createQuestion(item({
    intent: { kind: "plan-review", approve: "Да" },
    detail: "план",
  }), { now: NOW });
  assert.equal(review.allowFreeText, false, "у plan-review свободного ответа нет");
});

test("вопрос без id отвергается: отвечать нечем", () => {
  assert.throws(() => createQuestion({ question: "без id" }, { now: NOW }), /id/);
  assert.throws(() => createQuestion(null, { now: NOW }), /объект/i);
});

test("toAnswer до ответа бросает: спрашивать нечего", () => {
  const question = opened();
  assert.throws(() => question.toAnswer(), /не отвечен/);
});

test("ответ принимается только из open и только один раз", () => {
  const logs = [];
  const question = createQuestion(item(), { now: NOW, log: (message) => logs.push(message) });

  assert.equal(question.accept({ selected: ["Да"] }), false, "pending ещё не отправлен");
  assert.equal(question.status, QUESTION_STATUS.pending);

  question.markOpen(NOW);
  assert.equal(question.accept({ selected: ["Да"] }, { answeredBy: "u1", now: NOW + 5 }), true);
  assert.equal(question.status, QUESTION_STATUS.answered);
  assert.equal(question.answeredBy, "u1");
  assert.equal(question.answeredAt, NOW + 5);
  assert.deepEqual(question.toAnswer(), { id: "q1", selected: ["Да"] });

  assert.equal(question.accept({ selected: ["Нет"] }), false, "повтор — no-op");
  assert.deepEqual(question.toAnswer(), { id: "q1", selected: ["Да"] }, "первый ответ не перезаписан");
  assert.match(logs.join("\n"), /статус answered/);
});

test("одиночный вопрос не принимает два варианта", () => {
  const question = opened();
  assert.equal(question.accept({ selected: ["Да", "Нет"] }), false);
  assert.equal(question.status, QUESTION_STATUS.open, "вопрос остаётся открытым");
});

test("неизвестный вариант ответа отклоняется", () => {
  const question = opened();
  assert.equal(question.accept({ selected: ["Может быть"] }), false);
});

test("свободный ответ: принимается, обрезается и уходит в toAnswer", () => {
  const question = opened();
  assert.equal(question.accept({ selected: [], custom: "  давай позже  " }), true);
  assert.deepEqual(question.toAnswer(), { id: "q1", selected: [], custom: "давай позже" });
});

test("свободный ответ запрещён у plan-review", () => {
  const question = createQuestion(item({ intent: { kind: "plan-review", approve: "Да" } }), { now: NOW });
  question.markOpen(NOW);
  assert.equal(question.accept({ selected: [], custom: "своё" }), false);
  assert.equal(question.accept({ selected: ["Да"] }), true);
});

test("пустой ответ (ни варианта, ни текста) отклоняется", () => {
  const question = opened();
  assert.equal(question.accept({}), false);
  assert.equal(question.accept({ selected: [], custom: "   " }), false);
});

test("multiSelect принимает несколько вариантов, selected остаётся метками", () => {
  const question = opened({ multiSelect: true });
  assert.equal(question.accept({ selected: ["Да", "Нет"], custom: "оба" }), true);
  assert.deepEqual(question.toAnswer(), { id: "q1", selected: ["Да", "Нет"], custom: "оба" });
});

test("cancel и expire закрывают вопрос и запрещают ответ", () => {
  const cancelled = opened();
  assert.equal(cancelled.cancel("аборт", NOW), true);
  assert.equal(cancelled.status, QUESTION_STATUS.cancelled);
  assert.equal(cancelled.accept({ selected: ["Да"] }), false);
  assert.throws(() => cancelled.toAnswer(), /не отвечен/);

  const expired = createQuestion(item({ id: "q2" }), { now: NOW });
  expired.markOpen(NOW);
  assert.equal(expired.expire(NOW + DEFAULT_TTL_MS), true);
  assert.equal(expired.status, QUESTION_STATUS.expired);
  assert.equal(expired.cancel("поздно"), false, "терминальный статус не меняется");
});

test("status остаётся строкой из перечня, toJSON без методов", () => {
  const question = opened();
  question.accept({ selected: ["Да"] });
  const json = question.toJSON();
  assert.equal(json.status, "answered");
  assert.equal(json.questionId, "q1");
  assert.deepEqual(json.answer, { selected: ["Да"] });
  assert.equal(typeof json.toAnswer, "undefined", "в состоянии — только данные");
});

test("createQuestions делает пачку с общим контекстом", () => {
  const questions = createQuestions([item({ id: "a" }), item({ id: "b" })], {
    now: NOW,
    sessionId: "s1",
    workspace: "/p",
  });
  assert.equal(questions.length, 2);
  assert.deepEqual(questions.map((question) => question.questionId), ["a", "b"]);
  assert.ok(questions.every((question) => question.sessionId === "s1"));
  assert.ok(questions.every((question) => question instanceof RemoteQuestion));
});
