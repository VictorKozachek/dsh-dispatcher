/**
 * Тесты уведомлений доски (014): чтение `.kanban/tasks` только на чтение,
 * дедуп, тихие часы, лимит текста и флаг `notify: false`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectNotices,
  createNotifier,
  inQuietHours,
  noticeText,
  parseFrontMatter,
  readBoard,
} from "../lib/notify.js";
import { createStore } from "../lib/store.js";

/** Временный проект с доской. */
function makeWorkspace(t, cards, { minTodo = 3 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-notify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tasksDir = path.join(dir, ".kanban", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".kanban", "board.json"), JSON.stringify({ minTodo }));
  for (const card of cards) writeCard(dir, card);
  return dir;
}

function cardText(card) {
  return [
    "---",
    `id: "${card.id}"`,
    `title: "${card.title ?? `Задача ${card.id}`}"`,
    `status: ${card.status}`,
    `updated: ${card.updated ?? "2026-11-03T18:00:00Z"}`,
    ...(card.note === undefined ? [] : [`note: "${card.note}"`]),
    "---",
    "",
    "## Задача",
    "",
    "текст",
    "",
  ].join("\n");
}

function writeCard(workspace, card) {
  const tasksDir = path.join(workspace, ".kanban", "tasks");
  fs.writeFileSync(path.join(tasksDir, `${card.id}.md`), cardText(card));
}

/** Хэш и mtime всех файлов доски: доказываем, что мы только читали. */
function boardFingerprint(workspace) {
  const dir = path.join(workspace, ".kanban");
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = fs.statSync(full);
      out[full] = `${createHash("sha256").update(fs.readFileSync(full)).digest("hex")}:${stat.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

/** Notifier на фейковых часах с записью отправленных сообщений. */
function makeNotifier(t, workspace, overrides = {}) {
  const store = createStore({ file: path.join(workspace, "state.json") });
  const sent = [];
  const clock = { value: new Date(2026, 10, 3, 12, 0, 0).getTime() }; // 12:00
  const notifier = createNotifier({
    store,
    workspaces: [workspace],
    send: async (message) => {
      sent.push(message);
    },
    now: () => clock.value,
    quietHours: overrides.quietHours ?? { from: 23, to: 8 },
    intervalMs: 0,
    log: () => {},
    ...overrides.options,
  });
  return { notifier, store, sent, clock };
}

test("readBoard: карточки и minTodo читаются, файлы не меняются", (t) => {
  const workspace = makeWorkspace(t, [
    { id: "001", status: "ready" },
    { id: "002", status: "blocked", note: "нужен токен" },
  ]);
  const before = boardFingerprint(workspace);

  const board = readBoard({ workspace });

  assert.equal(board.cards.length, 2);
  assert.equal(board.minTodo, 3);
  assert.deepEqual(boardFingerprint(workspace), before, "доска только читается");
});

test("parseFrontMatter: кавычки, комментарии и пустые поля", () => {
  const meta = parseFrontMatter('---\nid: "007"\nstatus: blocked\ntitle: Задача\nowner: \n---\nтело');
  assert.deepEqual(meta, { id: "007", status: "blocked", title: "Задача", owner: "" });
});

test("переход в ready: одно уведомление, повторное чтение не дублирует", async (t) => {
  const workspace = makeWorkspace(t, [{ id: "001", status: "todo", updated: "t1" }]);
  const { notifier, sent } = makeNotifier(t, workspace);

  await notifier.scan(); // базовый проход: молчим
  assert.equal(sent.length, 0, "историю не спамим");

  writeCard(workspace, { id: "001", status: "ready", updated: "t2" });
  const first = await notifier.scan();
  const afterFirst = sent.length;

  writeCard(workspace, { id: "001", status: "ready", updated: "t2" });
  await notifier.scan();

  const ready = first.filter((notice) => notice.kind === "ready");
  assert.equal(ready.length, 1);
  assert.match(sent.at(-1).text, /#001/, "номер карточки в тексте");
  assert.match(sent.at(-1).text, /можно вливать/);
  assert.equal(sent.length, afterFirst, "дедуп по id:status:updated");
});

test("blocked: уведомление содержит причину из note", async (t) => {
  const workspace = makeWorkspace(t, [{ id: "002", status: "in-progress", updated: "t1" }]);
  const { notifier, sent } = makeNotifier(t, workspace);
  await notifier.scan();

  writeCard(workspace, { id: "002", status: "blocked", updated: "t2", note: "нужен человек: токен" });
  await notifier.scan();

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /нужен человек/);
  assert.match(sent[0].text, /нужен человек: токен/);
});

test("todo ниже minTodo: уведомление «пора выдать»", async (t) => {
  const workspace = makeWorkspace(t, [
    { id: "001", status: "todo", updated: "t1" },
    { id: "002", status: "todo", updated: "t1" },
    { id: "003", status: "backlog", updated: "t1" },
  ], { minTodo: 3 });
  const { notifier, sent } = makeNotifier(t, workspace);
  await notifier.scan(); // baseline: todo=2

  writeCard(workspace, { id: "003", status: "todo", updated: "t2" }); // todo=3
  await notifier.scan();
  writeCard(workspace, { id: "003", status: "backlog", updated: "t3" }); // todo=2 снова
  await notifier.scan();

  const low = sent.filter((message) => /пора выдать/.test(message.text));
  assert.equal(low.length, 1, "сигнал только на падение ниже минимума");
  assert.match(low[0].text, /в todo 2, минимум 3/);
});

test("тихие часы: ночью не шлём, днём отправляем отложенное", async (t) => {
  const workspace = makeWorkspace(t, [{ id: "001", status: "todo", updated: "t1" }]);
  const { notifier, sent, clock } = makeNotifier(t, workspace);
  await notifier.scan();

  clock.value = new Date(2026, 10, 3, 23, 30, 0).getTime(); // ночь
  writeCard(workspace, { id: "001", status: "ready", updated: "t2" });
  await notifier.scan();
  assert.equal(sent.length, 0, "ночью тихо");
  assert.equal(notifier.stats.skippedQuiet, 1, "отложено, не потеряно");

  clock.value = new Date(2026, 10, 4, 9, 0, 0).getTime(); // утро
  await notifier.scan();
  assert.equal(sent.length, 1, "днём уведомление доставлено");
  assert.match(sent[0].text, /можно вливать/);
});

test("inQuietHours: окно через полночь", () => {
  const at = (hour) => new Date(2026, 10, 3, hour, 30, 0).getTime();
  assert.equal(inQuietHours(at(23), { from: 23, to: 8 }), true);
  assert.equal(inQuietHours(at(2), { from: 23, to: 8 }), true);
  assert.equal(inQuietHours(at(8), { from: 23, to: 8 }), false);
  assert.equal(inQuietHours(at(12), { from: 23, to: 8 }), false);
  assert.equal(inQuietHours(at(12), { from: 23, to: 23 }), false, "пустое окно");
});

test("notify: false — уведомлений нет даже при переходах", async (t) => {
  const workspace = makeWorkspace(t, [{ id: "001", status: "todo", updated: "t1" }]);
  const { notifier, sent } = makeNotifier(t, workspace, { options: { enabled: false } });

  writeCard(workspace, { id: "001", status: "ready", updated: "t2" });
  await notifier.scan();

  assert.equal(sent.length, 0);
  notifier.start(); // выключенный не взводит таймер
  notifier.stop();
});

test("noticeText: воркспейс и номер карточки, обрезка под лимит транспорта", () => {
  const text = noticeText({
    workspace: "/p/dsh-dispatcher",
    cardId: "007",
    title: "можно вливать",
    reason: "",
  });
  assert.match(text, /^dsh-dispatcher · #007: можно вливать$/);

  const long = noticeText({ workspace: "/p/x", cardId: "001", title: "т".repeat(500), reason: "" }, { maxText: 80 });
  assert.equal(long.length <= 80, true);
  assert.match(long, /…$/);
});

test("collectNotices: baseline без уведомлений и дедуп по ключу", () => {
  const seen = new Set();
  const board = { cards: [{ id: "001", status: "ready", updated: "t1" }], minTodo: null };
  const first = collectNotices({ board, seen, lastTodo: null, workspace: "/p/x" });
  assert.equal(first.notices.length, 1, "ready детектится");
  const again = collectNotices({ board, seen: first.nextSeen, lastTodo: null, workspace: "/p/x" });
  assert.equal(again.notices.length, 0, "повтор с тем же updated не дублируется");
});

test("maxText: уведомление не длиннее лимита канала", async (t) => {
  const workspace = makeWorkspace(t, [{ id: "001", status: "todo", updated: "t1" }]);
  const { notifier, sent } = makeNotifier(t, workspace, { options: { maxText: 60 } });
  await notifier.scan();

  writeCard(workspace, { id: "001", status: "ready", updated: "t2", note: "очень длинное пояснение ".repeat(20) });
  await notifier.scan();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text.length <= 60, true, `длина ${sent[0].text.length}`);
  assert.match(sent[0].text, /dsh-notify-|#001/);
});

test("фича notify: false в конфиге выключает фичу", async () => {
  const { notifyFeature } = await import("../lib/features/notify.js");
  const provided = new Map();
  const ctx = { provide: (name, service) => provided.set(name, service), get: () => null };
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: () => null,
    onDispose: () => {},
  };

  notifyFeature.apply(ctx, { notify: false }, deps);
  assert.equal(provided.has("remoteNotifier"), false, "сервис не зарегистрирован");

  notifyFeature.apply(ctx, { notify: { enabled: false, workspaces: ["/p"] } }, deps);
  assert.equal(provided.has("remoteNotifier"), false, "enabled:false тоже выключает");
});
