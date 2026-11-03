/**
 * Тесты маршрутизации входящих ответов.
 *
 * Вопросы — настоящие объекты домена (002), `callback_data` — из общего хелпера
 * (003), allowlist проверяется настоящим транспортом (004) на фейковом `fetch`.
 * Сети нет; часы подменены.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createQuestion } from "../lib/domain/question.js";
import { callbackData } from "../lib/transport/base.js";
import { createTelegramTransport } from "../lib/transport/telegram.js";
import {
  FREE_TEXT_OPTION,
  MORE_OPTION,
  TRUNCATION_MARKER,
  createQuestionStore,
  describeOpen,
  normalizeText,
  routeIncoming,
} from "../lib/routing.js";

const NOW = 1_000_000;

/** Ответ «как от fetch»: тело в `json()`, как ждёт транспорт. */
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Открытый вопрос домена (002) в том виде, в каком он приходит роутингу. */
function openQuestion({ id = "q1", workspace = "/p/dsh-dispatcher", taskId = null, options } = {}) {
  const question = createQuestion({
    id,
    question: `Вопрос ${id}`,
    options: options ?? [{ label: "Да" }, { label: "Нет" }],
  }, { now: NOW, workspace, role: "worker", taskId });
  question.markOpen(NOW);
  return question;
}

/** Роутинг с часами и логом в массив: подпись повторяется в каждом тесте. */
function router(store, { caps = {}, log = [] } = {}) {
  return (answer) => routeIncoming({
    transport: { caps: { maxText: 4096, maxOptions: 8, ...caps } },
    answer,
    store,
    log: (message) => log.push(message),
    now: () => NOW,
  });
}

test("кнопка попадает точно в свой вопрос из двух открытых", () => {
  const first = openQuestion({ id: "q1" });
  const second = openQuestion({ id: "q2", workspace: "/p/other" });
  const store = createQuestionStore([first, second]);

  const result = router(store)({ callbackData: callbackData(second.shortId, "o2") });

  assert.equal(result.question, second);
  assert.deepEqual(result.answer, { id: "q2", selected: ["Нет"] });
  assert.equal(first.isOpen, true, "чужой вопрос не тронут");
});

test("кнопка с чужим shortId и чужим вариантом — ignored", () => {
  const question = openQuestion();
  const store = createQuestionStore([question]);
  const log = [];
  const route = router(store, { log });

  assert.equal(route({ callbackData: callbackData("deadbeef", "o1") }), "ignored");
  assert.equal(route({ callbackData: callbackData(question.shortId, "o9") }), "ignored");
  assert.equal(question.isOpen, true, "вопрос остался открытым");
  assert.match(log.join("\n"), /вопроса нет|варианта/);
});

test("повторное нажатие не перетирает первый ответ", () => {
  const question = openQuestion();
  const store = createQuestionStore([question]);
  const route = router(store);

  const first = route({ callbackData: callbackData(question.shortId, "o1") });
  assert.equal(first.answer.selected[0], "Да");

  const second = route({ callbackData: callbackData(question.shortId, "o2") });
  assert.equal(second, "ignored");
  assert.deepEqual(question.toAnswer(), { id: "q1", selected: ["Да"] });
});

test("reply адресует вопрос того сообщения", () => {
  const first = openQuestion({ id: "q1" });
  const second = openQuestion({ id: "q2" });
  const store = createQuestionStore([first, second]);
  store.registerMessage(500, second.shortId);

  const result = router(store)({ text: "  свой ответ  ", replyToMessageId: 500 });

  assert.equal(result.question, second);
  assert.deepEqual(result.answer, { id: "q2", selected: [], custom: "свой ответ" });
  assert.equal(first.isOpen, true);
});

test("reply на неизвестное сообщение — ignored", () => {
  const store = createQuestionStore([openQuestion()]);

  assert.equal(router(store)({ text: "текст", replyToMessageId: 999 }), "ignored");
});

test("один открытый вопрос со свободным ответом получает текст без reply", () => {
  const question = openQuestion();
  const store = createQuestionStore([question]);

  const result = router(store)({ text: "беру" });

  assert.equal(result.question, question);
  assert.equal(result.answer.custom, "беру");
  assert.equal(question.isOpen, false);
});

test("два открытых free-text вопроса: ambiguous, оба живы, подсказка описывает оба", () => {
  const first = openQuestion({ id: "q1", taskId: "007" });
  const second = openQuestion({ id: "q2", workspace: "/p/other-project" });
  const store = createQuestionStore([first, second]);

  const result = router(store)({ text: "беру" });

  assert.equal(result, "ambiguous");
  assert.equal(first.isOpen, true, "ответ не потерян — вопрос открыт");
  assert.equal(second.isOpen, true);

  const help = describeOpen([first, second]);
  assert.match(help, /^1\. dsh-dispatcher · task 007 — «Вопрос q1»/);
  assert.match(help, /2\. other-project — «Вопрос q2»/);
});

test("«Другой ответ…» переводит в ожидание текста, текст засчитывается один раз", () => {
  const question = openQuestion();
  const store = createQuestionStore([question]);
  const route = router(store);

  const pressed = route({ callbackData: callbackData(question.shortId, FREE_TEXT_OPTION) });
  assert.equal(pressed.question, question);
  assert.equal(pressed.answer, null, "ответа ещё нет — ждём текст");
  assert.equal(pressed.awaitingText, true);
  assert.equal(question.isOpen, true);

  const answered = route({ text: "свободный" });
  assert.equal(answered.question, question);
  assert.deepEqual(answered.answer, { id: "q1", selected: [], custom: "свободный" });

  assert.equal(route({ text: "ещё раз" }), "ignored", "повторный текст не перетирает ответ");
  assert.deepEqual(question.toAnswer(), { id: "q1", selected: [], custom: "свободный" });
});

test("«Другой ответ…» при нескольких вопросах: текст идёт в ждущий", () => {
  const first = openQuestion({ id: "q1" });
  const second = openQuestion({ id: "q2" });
  const store = createQuestionStore([first, second]);
  const route = router(store);

  route({ callbackData: callbackData(second.shortId, FREE_TEXT_OPTION) });
  const result = route({ text: "во второй" });

  assert.equal(result.question, second);
  assert.equal(second.isOpen, false);
  assert.equal(first.isOpen, true);
});

test("«Показать ещё» не отвечает на вопрос, а просит раскрыть варианты", () => {
  const question = openQuestion();
  const store = createQuestionStore([question]);

  const result = router(store)({ callbackData: callbackData(question.shortId, MORE_OPTION) });

  assert.equal(result.question, question);
  assert.equal(result.answer, null);
  assert.equal(result.showMore, true);
  assert.equal(question.isOpen, true);
});

test("пустой текст и один пробел — ignored", () => {
  const store = createQuestionStore([openQuestion()]);
  const route = router(store);

  assert.equal(route({ text: "" }), "ignored");
  assert.equal(route({ text: "   \n  " }), "ignored");
});

test("многострочный текст принимается целиком", () => {
  const question = openQuestion();
  const store = createQuestionStore([question]);

  const result = router(store)({ text: "строка 1\nстрока 2\n\nстрока 3" });

  assert.equal(result.answer.custom, "строка 1\nстрока 2\n\nстрока 3");
});

test("длинный текст усечён по caps.maxText с честным маркером", () => {
  const question = openQuestion();
  const store = createQuestionStore([question]);
  const long = "я".repeat(200);

  const result = router(store, { caps: { maxText: 50 } })({ text: long });

  assert.ok(result.answer.custom.length <= 50, `длина ${result.answer.custom.length} > 50`);
  assert.match(result.answer.custom, new RegExp(TRUNCATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("normalizeText: trim, пустой, усечение и суррогатная пара", () => {
  assert.equal(normalizeText("  текст  "), "текст");
  assert.equal(normalizeText("   "), null);
  assert.equal(normalizeText("строка\nвторая"), "строка\nвторая");

  const emoji = normalizeText("😀".repeat(100), 40);
  assert.ok(emoji.length <= 40);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji), false);
});

test("describeOpen: номера, воркспейс, задача; без воркспейса — только задача", () => {
  const first = openQuestion({ id: "q1", taskId: "007" });
  const second = openQuestion({ id: "q2", workspace: null, taskId: null });

  const help = describeOpen([first, second]);

  assert.match(help, /^1\. dsh-dispatcher · task 007 — «Вопрос q1»/);
  assert.match(help, /2\. «Вопрос q2»/);
  assert.equal(describeOpen([]), "");
  assert.equal(describeOpen(null), "");
});

test("текст от чужого пользователя не доходит до роутинга, от своего — попадает (004)", async () => {
  const first = openQuestion({ id: "q1" });
  const store = createQuestionStore([first]);
  const routed = [];
  const polls = [];
  let sent = 0;

  const fetchImpl = async (url, init = {}) => {
    const method = url.split("/").pop();
    if (method === "getUpdates") {
      return new Promise((resolve, reject) => {
        polls.push(resolve);
        init.signal?.addEventListener?.("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
    sent += 1;
    return jsonResponse({ ok: true, result: { message_id: 100 + sent, username: "test_bot" } });
  };

  const transport = createTelegramTransport({
    token: "123456:TEST-TOKEN",
    chatId: 42,
    allowedUserIds: [7],
    fetch: fetchImpl,
    jitter: () => 0,
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
    persistOffset: () => {},
  });
  transport.onAnswer((answer) => routed.push(routeIncoming({ transport, answer, store, now: () => NOW })));

  const settle = async () => {
    for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  // Вопрос отправлен транспортом — только тогда он знает, к какому вопросу
  // относится свободный текст (единственный открытый).
  await transport.sendQuestion(first);
  await transport.start();
  await settle();

  const textUpdate = (updateId, from, text, replyTo) => jsonResponse({
    ok: true,
    result: [{
      update_id: updateId,
      message: {
        from: { id: from },
        chat: { id: 42 },
        text,
        ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }),
      },
    }],
  });

  polls.shift()(textUpdate(1, 99, "чужой текст"));
  await settle();
  assert.deepEqual(routed, [], "чужой текст отброшен allowlist'ом 004");
  assert.equal(first.isOpen, true);

  polls.shift()(textUpdate(2, 7, "свой текст"));
  await settle();
  assert.equal(routed.length, 1, "свой текст дошёл до роутинга");
  assert.equal(routed[0].question, first);
  assert.equal(routed[0].answer.custom, "свой текст");
  assert.equal(first.isOpen, false);

  // reply на сообщение вопроса — тоже через 004.
  const second = openQuestion({ id: "q2" });
  store.add(second);
  const sentSecond = await transport.sendQuestion(second);
  polls.shift()(textUpdate(3, 7, "ответ реплаем", sentSecond.messageId));
  await settle();
  assert.equal(routed.length, 2);
  assert.equal(routed[1].question, second, "reply адресован второму вопросу");
  assert.equal(second.isOpen, false);

  await transport.stop();
});

// --- регрессии по ревью 007 -------------------------------------------------

test("текст с явным shortId адресует именно этот вопрос (двух открытых)", () => {
  const first = openQuestion({ id: "q1" });
  const second = openQuestion({ id: "q2", workspace: "/p/other" });
  const store = createQuestionStore([first, second]);

  const result = router(store)({ shortId: second.shortId, text: "во второй" });

  assert.equal(result.question, second);
  assert.deepEqual(result.answer, { id: "q2", selected: [], custom: "во второй" });
  assert.equal(first.isOpen, true, "первый вопрос не тронут");
});

test("текст с shortId не уезжает в вопрос, ждущий «Другой ответ…»", () => {
  const waiting = openQuestion({ id: "q3" });
  const target = openQuestion({ id: "q4" });
  const store = createQuestionStore([waiting, target]);
  const route = router(store);
  route({ callbackData: callbackData(waiting.shortId, FREE_TEXT_OPTION) });

  const result = route({ shortId: target.shortId, text: "в четвёртый" });

  assert.equal(result.question, target);
  assert.equal(waiting.isOpen, true);
});

test("reply в snake_case и вложенный reply_to_message тоже понимаются", () => {
  const first = openQuestion({ id: "q1" });
  const second = openQuestion({ id: "q2" });
  const store = createQuestionStore([first, second]);
  store.registerMessage(500, second.shortId);
  const route = router(store);

  assert.equal(route({ text: "snake", reply_to_message_id: 500 }).question, second);

  const nested = openQuestion({ id: "q3" });
  store.add(nested);
  store.registerMessage(600, nested.shortId);
  assert.equal(route({ text: "nested", reply_to_message: { message_id: 600 } }).question, nested);
});

test("малый caps.maxText: ответ не вылезает за лимит", () => {
  const question = openQuestion();
  const store = createQuestionStore([question]);

  for (const maxText of [5, 8]) {
    const fresh = openQuestion({ id: `q-${maxText}` });
    store.add(fresh);
    const result = router(store, { caps: { maxText } })({ shortId: fresh.shortId, text: "я".repeat(100) });
    assert.ok(result.answer.custom.length <= maxText, `при maxText ${maxText} длина ${result.answer.custom.length}`);
  }
});

test("describeOpen: вопрос из 002 без taskId — контекст подставляется резолвером", () => {
  const question = openQuestion({ id: "q1" });
  assert.equal(question.taskId, null, "домен 002 задачу не знает");

  const bare = describeOpen([question]);
  assert.doesNotMatch(bare, /task /, "без контекста задачи нет — это ожидаемо");

  const withContext = describeOpen([question], {
    contextOf: () => ({ workspace: "/p/dsh-dispatcher", taskId: "007" }),
  });
  assert.match(withContext, /^1\. dsh-dispatcher · task 007 — «Вопрос q1»/);
});
