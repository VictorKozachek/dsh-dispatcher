/**
 * Тесты слоя транспорта: контракт, хелперы и `fake`-транспорт.
 *
 * Сети здесь нет и быть не должно: `callback_data` проверяется на байтах,
 * `splitText` — на эмодзи и длинных строках, троттлинг — на фейковых часах,
 * а `fake` изображает мессенджер целиком.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CALLBACK_LIMIT_BYTES,
  DEFAULT_CAPS,
  TRANSPORT_METHODS,
  callbackData,
  checkTransport,
  chrome,
  parseCallbackData,
  splitText,
  throttle,
} from "../lib/transport/base.js";
import { createFakeTransport } from "../lib/transport/fake.js";

const SHORT = "a1b2c3d4";

/** Кнопка/строка без одиночных суррогатов: так проверяется «не рвём UTF-8». */
const hasLoneSurrogate = (text) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

test("контракт: fake проходит проверку, а недоделанный транспорт — нет", () => {
  const transport = createFakeTransport();
  assert.deepEqual(checkTransport(transport), { ok: true, missing: [] });

  const broken = checkTransport({ id: "telegram" });
  assert.equal(broken.ok, false);
  for (const method of TRANSPORT_METHODS) {
    assert.ok(broken.missing.includes(method), `в отчёте нет ${method}`);
  }
  assert.ok(broken.missing.includes("caps"));

  assert.deepEqual(checkTransport(null), { ok: false, missing: ["(объект)"] });
});

test("caps по умолчанию описывают возможности мессенджера", () => {
  assert.deepEqual(Object.keys(DEFAULT_CAPS).sort(), [
    "editAfterAnswer",
    "inlineButtons",
    "maxOptions",
    "maxText",
  ]);
  const transport = createFakeTransport({ caps: { maxOptions: 3, inlineButtons: false } });
  assert.equal(transport.caps.maxOptions, 3);
  assert.equal(transport.caps.inlineButtons, false);
  assert.equal(transport.caps.maxText, DEFAULT_CAPS.maxText, "остальное берётся из умолчаний");
});

test("callback_data: round-trip и не больше 64 байт", () => {
  const data = callbackData(SHORT, "o1");
  assert.equal(data, "q:a1b2c3d4:o1");
  assert.ok(Buffer.byteLength(data, "utf8") <= CALLBACK_LIMIT_BYTES);
  assert.deepEqual(parseCallbackData(data), { shortId: SHORT, optionId: "o1" });
});

test("callback_data: длинные части — ошибка, а не молчаливая обрезка", () => {
  assert.throws(() => callbackData("x".repeat(64), "o1"), RangeError);
  assert.throws(() => callbackData("", "o1"), TypeError);
  assert.throws(() => callbackData(SHORT, ""), TypeError);
  assert.throws(() => callbackData("a:b", "o1"), TypeError, "двоеточие ломает разбор");
});

test("callback_data: мусор от мессенджера не бросает, а отдаёт null", () => {
  for (const garbage of [
    null,
    undefined,
    42,
    "",
    "нажал",
    "q:a1b2c3d4",
    "q:a1b2c3d4:o1:лишнее",
    "x:a1b2c3d4:o1",
    "q::o1",
    "q:a1b2c3d4:",
    `q:${"y".repeat(80)}:o1`,
  ]) {
    assert.equal(parseCallbackData(garbage), null, `не разобрал ${JSON.stringify(garbage)}`);
  }
});

test("splitText: короткий текст не режется", () => {
  assert.deepEqual(splitText("привет", 100), ["привет"]);
  assert.deepEqual(splitText("", 100), []);
  assert.deepEqual(splitText(null, 100), []);
});

test("splitText: длинный текст режется под предел без потерь", () => {
  const source = Array.from({ length: 200 }, (_, index) => `строка ${index} с words`).join("\n");
  const chunks = splitText(source, 100);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), source, "склейка даёт исходный текст");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100, `кусок длиной ${chunk.length} больше предела`);
  }
});

test("splitText: слово длиннее предела режется по code points", () => {
  const chunks = splitText("a".repeat(250), 100);
  assert.equal(chunks.join(""), "a".repeat(250));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 50]);
});

test("splitText: эмодзи не разрываются между кусками", () => {
  const source = "😀😀😀😀😀";
  const chunks = splitText(source, 4);

  assert.equal(chunks.join(""), source, "ни один символ не потерян");
  for (const chunk of chunks) {
    assert.equal(hasLoneSurrogate(chunk), false, `кусок ${JSON.stringify(chunk)} режет суррогат`);
    assert.equal(Buffer.from(chunk, "utf8").toString("utf8"), chunk, "кусок — валидный UTF-8");
  }
  assert.deepEqual(chunks, ["😀😀", "😀😀", "😀"], "эмодзи (2 единицы) влезают парами");
});

test("splitText: предел 1 всё равно не рвёт суррогатную пару", () => {
  const chunks = splitText("😀", 1);
  assert.deepEqual(chunks, ["😀"], "лучше превысить предел на одну единицу, чем порвать пару");
  assert.equal(chunks.join(""), "😀");
});

test("splitText: неположительный предел — ошибка", () => {
  assert.throws(() => splitText("текст", 0), RangeError);
  assert.throws(() => splitText("текст", -1), RangeError);
});

test("chrome раскладывает варианты по строкам", () => {
  assert.deepEqual(chrome(["a", "b", "c", "d", "e"], 2), [["a", "b"], ["c", "d"], ["e"]]);
  assert.deepEqual(chrome(["a", "b"], 1), [["a"], ["b"]]);
  assert.deepEqual(chrome(["a"], 0), [["a"]], "меньше единицы — по одной кнопке");
  assert.deepEqual(chrome([], 2), []);
  assert.deepEqual(chrome(undefined, 2), []);
});

test("throttle: интервал между стартами соблюдается на фейковых часах", async () => {
  let clock = 0;
  const waits = [];
  const starts = [];
  const runner = throttle([
    async () => {
      starts.push(clock);
      clock += 10;
      return "a";
    },
    async () => {
      starts.push(clock);
      return "b";
    },
    async () => {
      starts.push(clock);
      return "c";
    },
  ], 1000, {
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });

  const results = await runner.run();

  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(waits, [990, 1000], "ждём остаток интервала, а не весь интервал");
  assert.deepEqual(starts, [0, 1000, 2000]);
  assert.equal(runner.size, 0, "очередь отработана");
});

test("throttle: медленная задача не добавляет ожидания", async () => {
  let clock = 0;
  const waits = [];
  const runner = throttle([
    async () => {
      clock += 1500;
      return 1;
    },
    async () => 2,
  ], 1000, { now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });

  assert.deepEqual(await runner.run(), [1, 2]);
  assert.deepEqual(waits, [], "задача уже заняла больше интервала");
});

test("throttle: push добавляет задачу, ошибка задачи отклоняет прогон", async () => {
  const runner = throttle([], 0);
  runner.push(async () => "первая");
  runner.push(async () => {
    throw new Error("задача упала");
  });
  runner.push(async () => "третья");
  assert.equal(runner.size, 3);

  await assert.rejects(runner.run(), /задача упала/);
  assert.equal(runner.size, 1, "невыполненные задачи остаются в очереди");
});

test("throttle: пустая очередь — пустой результат", async () => {
  const runner = throttle([], 1000);
  assert.deepEqual(await runner.run(), []);
});

test("fake: отправка рисует кнопки с callback_data и запоминает сообщение", async () => {
  const transport = createFakeTransport();
  const question = {
    shortId: SHORT,
    body: "Продолжать деплой?",
    title: "Деплой",
    options: [{ id: "o1", label: "Да" }, { id: "o2", label: "Нет" }, { id: "o3", label: "Позже" }],
  };

  const sent = await transport.sendQuestion(question, { chatId: "42" });

  assert.equal(transport.messages.length, 1);
  assert.equal(transport.calls.send, 1);
  const [message] = transport.messages;
  assert.equal(message.messageId ?? sent.messageId, sent.messageId);
  assert.equal(message.shortId, SHORT);
  assert.equal(message.chatId, "42");
  assert.equal(message.text, "Продолжать деплой?");
  assert.deepEqual(message.rows.map((row) => row.map((button) => button.text)), [["Да", "Нет"], ["Позже"]]);
  assert.deepEqual(parseCallbackData(message.rows[0][0].callback_data), { shortId: SHORT, optionId: "o1" });
});

test("fake: caps ограничивают число кнопок, inlineButtons выключает их", async () => {
  const question = { shortId: SHORT, body: "?", options: [{ id: "o1", label: "1" }, { id: "o2", label: "2" }, { id: "o3", label: "3" }] };

  const narrow = createFakeTransport({ caps: { maxOptions: 2 } });
  await narrow.sendQuestion(question);
  assert.deepEqual(narrow.messages[0].rows.flat().map((button) => button.text), ["1", "2"]);

  const textOnly = createFakeTransport({ caps: { inlineButtons: false } });
  await textOnly.sendQuestion(question);
  assert.deepEqual(textOnly.messages[0].rows, [], "кнопок нет — вопрос текстом");
});

test("fake: ответ человека приходит через onAnswer, отписка работает", async () => {
  const transport = createFakeTransport();
  const received = [];
  const off = transport.onAnswer((answer) => received.push(answer));
  await transport.sendQuestion({ shortId: SHORT, body: "?", options: [{ id: "o1", label: "Да" }] });

  transport.answer(SHORT, "o1");
  assert.deepEqual(received[0].optionIds, ["o1"]);
  assert.equal(received[0].shortId, SHORT);
  assert.equal(received[0].answeredBy, "fake-user");
  assert.equal(transport.answers.length, 1);

  transport.answerText(SHORT, "свой ответ");
  assert.equal(received[1].text, "свой ответ");

  off();
  transport.answer(SHORT, "o1");
  assert.equal(received.length, 2, "после отписки событий нет");
  assert.equal(transport.subscribers, 0);
});

test("fake: закрытие вопроса снимает варианты и правит сообщение", async () => {
  const transport = createFakeTransport();
  const question = { shortId: SHORT, body: "Продолжать?", options: [{ id: "o1", label: "Да" }] };
  await transport.sendQuestion(question);

  await transport.closeQuestion(question, "отвечено: Да");

  const [message] = transport.messages;
  assert.equal(message.closed, true);
  assert.deepEqual(message.rows, [], "кнопки сняты");
  assert.equal(transport.closed.length, 1);
  assert.equal(message.summary, "отвечено: Да");
  assert.match(message.text, /отвечено: Да/, "при editAfterAnswer текст правится");
  assert.equal(transport.calls.close, 1);

  await transport.closeQuestion(question, "повтор");
  assert.equal(transport.calls.close, 2);
  assert.equal(transport.closed.length, 1, "второй раз закрывать нечего");
});

test("fake: closeAll закрывает все открытые сообщения", async () => {
  const transport = createFakeTransport();
  for (const shortId of ["a1b2c3d4", "b1b2c3d4"]) {
    await transport.sendQuestion({ shortId, body: "?", options: [] });
  }

  await transport.closeAll("плагин выгружен");

  assert.equal(transport.closed.length, 2);
  assert.ok(transport.messages.every((message) => message.closed === true));
});

test("fake: failNext роняет следующие отправки, healthCheck это показывает", async () => {
  const transport = createFakeTransport();
  const question = { shortId: SHORT, body: "?", options: [] };

  transport.failNext(2);
  assert.deepEqual(transport.healthCheck(), { ok: false, detail: "fake: запланировано падений 2" });
  await assert.rejects(transport.sendQuestion(question), /недоступен/);
  await assert.rejects(transport.sendQuestion(question), /недоступен/);
  await transport.sendQuestion(question);

  assert.equal(transport.messages.length, 1, "доставлен только последний");
  assert.equal(transport.calls.send, 3);
  assert.deepEqual(transport.healthCheck(), { ok: true, detail: "fake готов" });
});

test("fake: start/stop и счётчики вызовов", async () => {
  const transport = createFakeTransport();
  await transport.start();
  assert.equal(transport.started, true);
  await transport.stop();
  assert.equal(transport.started, false);
  transport.healthCheck();

  assert.deepEqual(transport.calls, {
    start: 1,
    stop: 1,
    send: 0,
    close: 0,
    health: 1,
    answer: 0,
  });
});
