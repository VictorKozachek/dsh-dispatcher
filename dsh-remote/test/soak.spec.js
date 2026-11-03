/**
 * Soak-тест эксплуатационной части (задача 036).
 *
 * Долгий прогон без реальных задержек: 1000+ вопросов через настоящий ответчик,
 * смесь «ответили», «истёк TTL» и «отменили». Проверяем то, что ломается только
 * со временем: потерянные/дублированные ответы, растущие таймеры и состояние,
 * журнал без ротации, неверные или немонотонные метрики (031).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAnswerer } from "../lib/answerer.js";
import { createRegistry } from "../lib/domain/registry.js";
import { createMetrics } from "../lib/metrics.js";
import { createJsonState, createReliability } from "../lib/reliability.js";
import { createFakeTransport } from "../lib/transport/fake.js";

const TOTAL = 1_000;
const TICK = Math.max(2, Math.ceil(TOTAL / 100));

const tickMs = async (times = 4) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-soak-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Часы: время двигается вручную или «сном» доставки. */
function fakeClock(start = 1_700_000_000_000) {
  let clock = start;
  return {
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    sleep: async (ms) => {
      clock += ms;
    },
  };
}

/** Таймеры-двойники: считают, сколько взведено и не снято. */
function countingTimers() {
  const active = new Set();
  let nextId = 1;
  return {
    active,
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      active.add(id);
      return id;
    },
    clearTimeout(id) {
      active.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId;
      nextId += 1;
      active.add(id);
      return id;
    },
    clearInterval(id) {
      active.delete(id);
    },
    get outstanding() {
      return active.size;
    },
  };
}

function fakeContext() {
  return {
    on: () => () => {},
    get: () => null,
    provide: () => {},
  };
}

function answererStand(t, { metrics, timers, clock, state, transport, reliability }) {
  return createAnswerer({
    transport,
    registry: createRegistry({ readState: () => ({ global: true }) }),
    reliability,
    metrics,
    now: clock.now,
    log: () => {},
  });
}

const next = async () => "gui";

test("soak: 1000 вопросов — ни потерь, ни дублей, ни утечек таймеров и состояния", async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const timers = countingTimers();
  const metrics = createMetrics({ now: clock.now });
  const state = createJsonState({ file: path.join(dir, "state.json"), now: clock.now });
  const transport = createFakeTransport({ now: clock.now });

  // main ещё до 034: stop() снимает интервал глобальным clearInterval, поэтому
  // синхронизируем счётчик с глобальным вызовом (иначе счётчик — не показатель).
  const realClearInterval = globalThis.clearInterval;
  globalThis.clearInterval = (id) => {
    timers.clearInterval(id);
    try {
      realClearInterval(id);
    } catch {
      /* id счётчика — не настоящий таймер */
    }
  };
  t.after(() => {
    globalThis.clearInterval = realClearInterval;
  });

  const reliability = createReliability({
    transport,
    state,
    logFile: path.join(dir, "log.jsonl"),
    logMaxBytes: 4_096,
    now: clock.now,
    sleep: clock.sleep,
    metrics,
    ttlMs: 50,
    reminderMs: 30,
    // Только интервалы: `withTimeout` внутри reliability снимает таймеры
    // глобальным clearTimeout, поэтому подменять setTimeout здесь нельзя.
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    logger: () => {},
  });

  const answerer = answererStand(t, { metrics, timers, clock, state, transport, reliability });
  answerer.attach(fakeContext());

  const answered = [];
  const expired = [];
  const cancelled = [];
  const shortIds = new Set();
  let previous = metrics.snapshot();
  const startedReal = Date.now();

  for (let index = 0; index < TOTAL; index += 1) {
    const controller = new AbortController();
    const request = {
      agent: { id: "session-soak" },
      questions: [{ id: `q${index}`, question: `Вопрос ${index}?`, options: [{ label: "Да" }] }],
      signal: controller.signal,
    };
    const outcome = answerer.handler(request, next);
    outcome.catch(() => {});

    // Дождаться отправки: доставка асинхронная, но без реальных задержек.
    for (let spin = 0; spin < 20 && transport.messages.length <= index; spin += 1) await tickMs(1);
    const message = transport.messages[index];
    assert.ok(message, `вопрос ${index} ушёл в канал`);
    assert.equal(shortIds.has(message.shortId), false, `shortId ${message.shortId} не дублируется`);
    shortIds.add(message.shortId);

    const mode = index % 10;
    if (mode === 0) {
      // Отмена хода: аборт, пока человек не ответил.
      controller.abort();
      await assert.rejects(outcome);
      cancelled.push(index);
    } else if (mode === 1) {
      // TTL: двигаем часы до expiresAt вопроса и прокручиваем сторож — исход
      // «истёк» (abort, как настроено onExpire), а не «потерян».
      const expiresAt = Number.isFinite(message.question?.expiresAt) ? message.question.expiresAt : clock.now() + 1;
      clock.advance(Math.max(1, expiresAt - clock.now() + 1));
      await reliability.tick();
      await assert.rejects(outcome);
      expired.push(index);
    } else {
      transport.answer(message.shortId, "o1");
      const result = await outcome;
      assert.equal(result?.answers?.length, 1, `ответ на вопрос ${index} доставлен`);
      answered.push(index);
    }

    if ((index + 1) % TICK === 0) {
      // Метрики только растут; очереди/сторож не накапливаются.
      const snapshot = metrics.snapshot();
      assert.ok(snapshot.questions.asked >= previous.questions.asked, "questions.asked монотонен");
      assert.ok(snapshot.questions.answered >= previous.questions.answered, "questions.answered монотонен");
      assert.ok(snapshot.questions.expired >= previous.questions.expired, "questions.expired монотонен");
      assert.ok(snapshot.questions.cancelled >= previous.questions.cancelled, "questions.cancelled монотонен");
      assert.ok(snapshot.deliveries.sent >= previous.deliveries.sent, "deliveries.sent монотонен");
      previous = snapshot;

      const stored = state.read();
      assert.deepEqual(stored.questions, [], "открытые вопросы не накапливаются в состоянии");
      assert.deepEqual(stored.pending, [], "очередь доставки пуста");
    }
  }

  const elapsedReal = Date.now() - startedReal;
  const snapshot = metrics.snapshot();
  const result = await reliability.healthCheck();
  const stored = state.read();

  // --- без потерь и дублей ---------------------------------------------------
  assert.equal(answered.length + expired.length + cancelled.length, TOTAL, "каждый вопрос получил ровно один исход");
  assert.equal(shortIds.size, TOTAL, "все shortId уникальны");
  assert.equal(transport.messages.length, TOTAL, "ровно одно сообщение на вопрос");
  assert.equal(snapshot.questions.asked, TOTAL, "asked = числу вопросов");
  assert.equal(snapshot.questions.answered, answered.length, "answered сходится с фактом");
  assert.equal(snapshot.questions.expired, expired.length, "expired сходится с TTL");
  // TTL-аборт — это тоже отменённое ожидание: `cancelled` считает аборты хода
  // и TTL-аборты, `expired` — отдельно истечения. Обе метрики честные.
  assert.equal(snapshot.questions.cancelled, cancelled.length + expired.length, "cancelled = аборты + TTL-аборты");
  assert.equal(snapshot.questions.expired, expired.length);
  assert.equal(
    snapshot.questions.answered + snapshot.questions.expired + cancelled.length,
    TOTAL,
    "каждый вопрос попал ровно в одну «основную» категорию",
  );
  // `deliveries.sent` считает доставки, доведённые до ожидания ответа: аборт
  // хода в момент ожидания уже не успевает в счётчик (но сообщение отправлено —
  // это видно по transport.messages). Ошибок и повторов нет.
  assert.equal(snapshot.deliveries.sent, TOTAL - cancelled.length, "sent = доставки без абортов");
  assert.equal(snapshot.deliveries.failed, 0, "ошибок доставки не было");
  assert.equal(snapshot.latency.count, answered.length, "латентность мерится только по ответам");

  // --- утечек нет ------------------------------------------------------------
  assert.equal(result.watching, 0, "TTL-сторож не держит ни одного вопроса");
  assert.equal(result.pending, 0, "очередь доставки пуста");
  assert.deepEqual(stored.questions, [], "state.questions пуст");
  assert.deepEqual(stored.pending, [], "state.pending пуст");
  assert.equal(timers.outstanding, 0, "повисших таймеров нет");
  assert.equal(transport.calls.stop, 0, "транспорт не останавливался сам");
  assert.equal(transport.calls.send, TOTAL, "ответчик отправил ровно TOTAL сообщений");

  // --- состояние не растёт бесконечно (033) ---------------------------------
  const journal = path.join(dir, "log.jsonl");
  // keep по умолчанию — 5 ротированных файлов (.1…​.5) + текущий.
  const rotated = [journal, ...Array.from({ length: 6 }, (_, index) => `${journal}.${index + 1}`)]
    .filter((file) => fs.existsSync(file));
  assert.ok(rotated.length <= 6, `ротация журнала ограничена: ${rotated.length} файлов`);
  for (const file of rotated) {
    const size = fs.statSync(file).size;
    assert.ok(size <= 4_096 + 2_048, `журнал ${path.basename(file)} ограничен (${size} байт)`);
  }
  assert.ok(fs.statSync(path.join(dir, "state.json")).size < 65_536, "state.json не пухнет от soak-прогона");

  // Сторож можно поднимать/снимать многократно: число интервалов не растёт.
  for (let cycle = 0; cycle < 100; cycle += 1) {
    reliability.start();
    reliability.stop();
  }
  assert.equal(timers.outstanding, 0, "после 100 циклов start/stop интервалов не осталось");

  // Завершение: stop/dispose идемпотентны и не оставляют ресурсов.
  answerer.dispose("soak-finished");
  reliability.stop();
  const closesAfterDispose = transport.calls.close;
  assert.doesNotThrow(() => answerer.dispose("soak-finished"), "повторный dispose безопасен");
  assert.equal(transport.calls.close, closesAfterDispose, "повторный dispose не закрывает ничего ещё раз");
  assert.equal(timers.outstanding, 0, "после shutdown таймеров нет");
  assert.ok(elapsedReal < 60_000, `soak без реальных задержек (${elapsedReal} мс на ${TOTAL} вопросов)`);
});
