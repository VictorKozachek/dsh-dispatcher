/**
 * Тесты представления вопроса: шапка «откуда», тело и ряды кнопок.
 *
 * Всё локально: фейковый `ctx.sessions`, временные каталоги с `.kanban/tasks` и
 * фиксированные часы. Никакой сети и никакой записи — доска только читается.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FREE_TEXT_LABEL,
  FREE_TEXT_OPTION,
  MORE_OPTION,
  MORE_LABEL,
  MULTISELECT_HINT,
  TRUNCATION_MARKER,
  WORKSPACE_LIMIT,
  findOwnedTask,
  formatTime,
  frontMatterField,
  renderBody,
  renderClock,
  renderHeader,
  renderRows,
  resolveContext,
  truncate,
} from "../lib/present.js";

const SESSION_ID = "session-aaa";
const CWD = "/Users/victor/projects/dsh-dispatcher";

/** Временный каталог с необязательным `.kanban/tasks`. */
function tempWorkspace(t, { cards = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-present-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (cards !== null) {
    const tasks = path.join(dir, ".kanban", "tasks");
    fs.mkdirSync(tasks, { recursive: true });
    for (const [name, text] of Object.entries(cards)) fs.writeFileSync(path.join(tasks, name), text);
  }
  return dir;
}

/** Карточка доски в формате `.kanban/tasks/README.md`. */
function card(id, owner) {
  return `---\nid: "${id}"\ntitle: "Задача ${id}"\nstatus: in-progress\nowner: ${owner === "" ? '""' : owner}\nrole: worker\n---\n\n## Задача\n`;
}

/** Фейковый `ctx` с сервисом сессий. */
function fakeCtx(sessions) {
  return { get: (name) => (name === "sessions" ? sessions : null) };
}

/** Сессия с шапкой: cwd и agentPreset. */
function session(cwd, agentPreset) {
  return { header: { cwd, ...(agentPreset === undefined ? {} : { agentPreset }) } };
}

test("resolveContext: воркспейс, роль и задача, которую ведёт эта сессия", (t) => {
  const dir = tempWorkspace(t, {
    cards: {
      "005.md": card("005", "session-other"),
      "006.md": card("006", SESSION_ID),
      "README.md": "не карточка",
    },
  });
  const ctx = fakeCtx({ get: () => session(dir, "worker") });

  const context = resolveContext({ sessionId: SESSION_ID, ctx });

  assert.equal(context.sessionId, SESSION_ID);
  assert.equal(context.cwd, dir);
  assert.equal(context.workspace, path.basename(dir));
  assert.equal(context.role, "worker");
  assert.equal(context.taskId, "006", "берётся карточка с owner === sessionId");
});

test("resolveContext: без задачи (чужой owner) — taskId нет", (t) => {
  const dir = tempWorkspace(t, { cards: { "005.md": card("005", "session-other") } });

  const context = resolveContext({ sessionId: SESSION_ID, ctx: fakeCtx({ get: () => session(dir, "worker") }) });

  assert.equal(context.taskId, null);
  assert.equal(context.workspace, path.basename(dir));
});

test("resolveContext: нет каталога .kanban — тихо, без taskId и без исключения", (t) => {
  const dir = tempWorkspace(t);
  const context = resolveContext({ sessionId: SESSION_ID, ctx: fakeCtx({ get: () => session(dir, "reviewer") }) });

  assert.equal(context.taskId, null);
  assert.equal(context.role, "reviewer");
  assert.equal(context.cwd, dir);
});

test("resolveContext: чужой/пропавший/бросающий sessions.get не роняет", () => {
  const missing = resolveContext({ sessionId: SESSION_ID, ctx: fakeCtx({ get: () => undefined }) });
  assert.deepEqual(missing, { sessionId: SESSION_ID, workspace: null, cwd: null, role: null, taskId: null });

  const throwing = resolveContext({
    sessionId: SESSION_ID,
    ctx: fakeCtx({
      get: () => {
        throw new Error("сессия потерялась");
      },
    }),
  });
  assert.equal(throwing.cwd, null);

  const noService = resolveContext({ sessionId: SESSION_ID, ctx: { get: () => null } });
  assert.equal(noService.workspace, null);

  const noSession = resolveContext({ sessionId: null, ctx: fakeCtx({ get: () => session(CWD) }) });
  assert.deepEqual(noSession, { sessionId: null, workspace: null, cwd: null, role: null, taskId: null });
});

test("resolveContext и findOwnedTask только читают карточки", (t) => {
  const dir = tempWorkspace(t, { cards: { "006.md": card("006", SESSION_ID) } });
  const file = path.join(dir, ".kanban", "tasks", "006.md");
  const before = fs.readFileSync(file, "utf8");
  const statBefore = fs.statSync(file);

  resolveContext({ sessionId: SESSION_ID, ctx: fakeCtx({ get: () => session(dir, "worker") }) });
  findOwnedTask(dir, SESSION_ID);

  assert.equal(fs.readFileSync(file, "utf8"), before, "содержимое карточки не изменилось");
  assert.equal(fs.statSync(file).mtimeMs, statBefore.mtimeMs, "mtime карточки не изменился");
  assert.deepEqual(fs.readdirSync(path.join(dir, ".kanban", "tasks")), ["006.md"], "новых файлов нет");
});

test("frontMatterField: кавычки, комментарии и отсутствие front matter", () => {
  assert.equal(frontMatterField('---\nowner: "session-x"\n---\n', "owner"), "session-x");
  assert.equal(frontMatterField("---\nowner: session-y  # кто ведёт\n---\n", "owner"), "session-y");
  assert.equal(frontMatterField("---\nowner: ''\n---\n", "owner"), "");
  assert.equal(frontMatterField("нет front matter", "owner"), null);
  assert.equal(frontMatterField('---\nid: "1"\n---\n', "owner"), null);
});

test("renderClock: локальное время и дедлайн", () => {
  const start = new Date(2026, 10, 3, 17, 41).getTime();
  const deadline = new Date(2026, 10, 3, 18, 11).getTime();

  assert.equal(renderClock(start, deadline), "17:41 · до 18:11");
  assert.equal(renderClock(start, null), "17:41", "без дедлайна — только время");
  assert.equal(formatTime(start), "17:41");
});

test("renderHeader: порядок сегментов как в CONCEPT §5.2", () => {
  const now = new Date(2026, 10, 3, 17, 41).getTime();
  const expiresAt = new Date(2026, 10, 3, 18, 11).getTime();

  assert.equal(
    renderHeader({ workspace: "dsh-dispatcher", taskId: "007", role: "worker", now, expiresAt }),
    "▸ dsh-dispatcher · task 007 · worker · 17:41 · до 18:11",
  );
  assert.equal(
    renderHeader({ workspace: "dsh-dispatcher", role: "worker", now, expiresAt }),
    "▸ dsh-dispatcher · worker · 17:41 · до 18:11",
    "без задачи — без сегмента task",
  );
  assert.equal(
    renderHeader({ workspace: "dsh-dispatcher", now }),
    "▸ dsh-dispatcher · 17:41",
    "без роли и дедлайна",
  );
});

test("renderHeader: длинный воркспейс усекается до 32 символов", () => {
  const long = "очень-длинное-имя-воркспейса-проекта-2026";
  const header = renderHeader({ workspace: long, now: new Date(2026, 10, 3, 17, 41).getTime() });

  const segment = header.replace("▸ ", "").split(" · ")[0];
  assert.ok(segment.length <= WORKSPACE_LIMIT, `сегмент ${segment.length} > ${WORKSPACE_LIMIT}`);
  assert.match(segment, /…/);
});

test("renderBody: шапка, пустая строка, тело вопроса", () => {
  const createdAt = new Date(2026, 10, 3, 17, 41).getTime();
  const expiresAt = new Date(2026, 10, 3, 18, 11).getTime();

  const body = renderBody({
    workspace: "/Users/victor/projects/dsh-dispatcher",
    role: "worker",
    taskId: "007",
    body: "Удалить ветку task/007 после слияния?",
    options: [{ id: "o1", label: "Да" }],
    createdAt,
    expiresAt,
  }, { maxText: 4096, maxOptions: 8 });

  assert.equal(body, [
    "▸ dsh-dispatcher · task 007 · worker · 17:41 · до 18:11",
    "",
    "Удалить ветку task/007 после слияния?",
  ].join("\n"));
});

test("renderBody: подсказка multiSelect", () => {
  const body = renderBody({ body: "Что берём?", multiSelect: true, createdAt: 0 }, { maxText: 4096 });

  assert.match(body, /Что берём\?/);
  assert.match(body, new RegExp(MULTISELECT_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("renderBody: усечение под caps.maxText с честным маркером", () => {
  const long = "а".repeat(200);
  const body = renderBody({ body: long, createdAt: 0 }, { maxText: 80 });

  assert.ok(body.length <= 80, `длина ${body.length} больше предела`);
  assert.match(body, new RegExp(TRUNCATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("renderBody: эмодзи на границе усечения не ломается", () => {
  const body = renderBody({ body: "😀".repeat(100), createdAt: 0 }, { maxText: 40 });

  assert.ok(body.length <= 40);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body), false, "нет одиночного суррогата");
});

test("truncate: предел и маркер", () => {
  assert.equal(truncate("abcdef", 10), "abcdef");
  assert.equal(truncate("abcdef", 4, "…"), "abc…");
  assert.equal(truncate("abcdef", 0), "");
  assert.equal(truncate(null, 5), "");
});

test("renderRows: вариант — одна кнопка в ряд, «Другой ответ…» последним", () => {
  const rows = renderRows({
    options: [{ id: "o1", label: "Да" }, { id: "o2", label: "Нет" }],
    allowFreeText: true,
  }, { maxOptions: 8 });

  assert.deepEqual(rows.map((row) => row.map((button) => button.label)), [["Да"], ["Нет"], [FREE_TEXT_LABEL]]);
  assert.deepEqual(rows[0][0], { label: "Да", kind: "option", optionId: "o1" });
  assert.deepEqual(rows.at(-1)[0], { label: FREE_TEXT_LABEL, kind: "free", optionId: FREE_TEXT_OPTION });
  assert.equal(rows.at(-1)[0].kind, "free");
});

test("renderRows: 12 вариантов при maxOptions 8 — «Показать ещё» и усечение ряда", () => {
  const options = Array.from({ length: 12 }, (_, index) => ({ id: `o${index + 1}`, label: `Вариант ${index + 1}` }));

  const rows = renderRows({ options, allowFreeText: true }, { maxOptions: 8 });

  assert.equal(rows.length, 8, "больше восьми рядов не рисуем");
  assert.deepEqual(rows.map((row) => row[0].kind), [
    "option", "option", "option", "option", "option", "option", "more", "free",
  ]);
  assert.equal(rows[6][0].label, MORE_LABEL);
  assert.equal(rows.at(-1)[0].label, FREE_TEXT_LABEL);
});

test("renderRows: без свободного ответа и без вариантов", () => {
  const noFree = renderRows({ options: [{ id: "o1", label: "Да" }], allowFreeText: false }, { maxOptions: 8 });
  assert.deepEqual(noFree.map((row) => row[0].kind), ["option"]);

  const empty = renderRows({ options: [], allowFreeText: true }, { maxOptions: 8 });
  assert.deepEqual(empty, [[{ label: FREE_TEXT_LABEL, kind: "free", optionId: FREE_TEXT_OPTION }]]);
});

test("renderRows: один вариант при maxOptions 2 — вариант и «Другой ответ…»", () => {
  const rows = renderRows({ options: [{ id: "o1", label: "Да" }], allowFreeText: true }, { maxOptions: 2 });

  assert.deepEqual(rows.map((row) => row[0].kind), ["option", "free"]);
  assert.equal(rows.length, 2, "не больше caps.maxOptions");
});

test("renderRows: лимит рядов соблюдается при maxOptions 1 и 0", () => {
  const manyOptions = Array.from({ length: 5 }, (_, index) => ({ id: `o${index}`, label: `Вариант ${index}` }));

  const single = renderRows({ options: manyOptions, allowFreeText: true }, { maxOptions: 1 });
  assert.equal(single.length, 1, "не больше одного ряда");
  assert.equal(single[0][0].kind, "free", "свободный ответ важнее раскрытия");

  const onlyOption = renderRows({ options: manyOptions, allowFreeText: false }, { maxOptions: 1 });
  assert.equal(onlyOption.length, 1);
  assert.equal(onlyOption[0][0].kind, "option");

  assert.deepEqual(renderRows({ options: manyOptions, allowFreeText: true }, { maxOptions: 0 }), []);
});

test("renderBody: заголовок и подробности вопроса не теряются", () => {
  const body = renderBody({
    workspace: "/p/dsh-dispatcher",
    title: "Деплой",
    body: "Продолжать деплой?",
    detail: "Сборка зелёная",
    createdAt: new Date(2026, 10, 3, 17, 41).getTime(),
  }, { maxText: 4096 });

  assert.match(body, /^▸ dsh-dispatcher · 17:41/);
  assert.match(body, /Деплой/);
  assert.match(body, /Продолжать деплой\?/);
  assert.match(body, /Сборка зелёная/);
  assert.ok(body.indexOf("Деплой") < body.indexOf("Продолжать деплой"), "заголовок выше тела");
  assert.ok(body.indexOf("Сборка зелёная") > body.indexOf("Продолжать деплой"), "подробности ниже тела");
});

test("findOwnedTask: из нескольких своих карточек выбирается активная, merged — нет", (t) => {
  const dir = tempWorkspace(t, {
    cards: {
      "001.md": card("001", SESSION_ID).replace("status: in-progress", "status: merged"),
      "006.md": card("006", SESSION_ID),
      "007.md": card("007", SESSION_ID).replace("status: in-progress", "status: todo"),
      "002.md": card("002", SESSION_ID),
    },
  });

  assert.equal(findOwnedTask(dir, SESSION_ID), "006", "in-progress важнее todo, merged не считается");
});

test("findOwnedTask: реальная раскладка root/worktree — карточка живёт в worktrees/<id>", (t) => {
  const root = tempWorkspace(t, {
    cards: {
      "001.md": card("001", SESSION_ID).replace("status: in-progress", "status: merged"),
      "002.md": card("002", "session-other"),
    },
  });
  const worktree = path.join(root, "worktrees", "006");
  fs.mkdirSync(path.join(worktree, ".kanban", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".kanban", "tasks", "006.md"), card("006", SESSION_ID));

  const context = resolveContext({ sessionId: SESSION_ID, ctx: fakeCtx({ get: () => session(root, "worker") }) });

  assert.equal(context.cwd, root);
  assert.equal(context.taskId, "006", "нашли карточку в рабочем дереве проекта");
  assert.equal(MORE_OPTION, "more");
});

test("renderRows maxOptions=2: переполнение уходит в «Показать ещё», а не теряется", () => {
  const options = (count) => Array.from({ length: count }, (_, index) => ({ id: `o${index}`, label: `В${index}` }));

  const two = renderRows({ options: options(2), allowFreeText: true }, { maxOptions: 2 });
  assert.deepEqual(two.map((row) => row[0].kind), ["option", "more"], "второй вариант доступен через «Показать ещё»");

  const three = renderRows({ options: options(3), allowFreeText: true }, { maxOptions: 2 });
  assert.deepEqual(three.map((row) => row[0].kind), ["option", "more"]);

  const one = renderRows({ options: options(1), allowFreeText: true }, { maxOptions: 2 });
  assert.deepEqual(one.map((row) => row[0].kind), ["option", "free"], "один вариант влезает вместе со свободным ответом");
});

test("findOwnedTask на реальной доске 005–008 и в рабочем дереве", (t) => {
  const root = tempWorkspace(t, {
    cards: {
      "005.md": card("005", SESSION_ID),
      "006.md": card("006", SESSION_ID),
      "007.md": card("007", SESSION_ID).replace("status: in-progress", "status: testing"),
      "008.md": card("008", SESSION_ID),
    },
  });

  // В корне все свои карточки: берём самую позднюю активную (in-progress 006/008 → 008).
  assert.equal(findOwnedTask(root, SESSION_ID), "008");

  // cwd внутри worktrees/006 — текущая задача именно 006.
  const worktree = path.join(root, "worktrees", "006");
  fs.mkdirSync(path.join(worktree, ".kanban", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".kanban", "tasks", "006.md"), card("006", SESSION_ID));
  assert.equal(findOwnedTask(worktree, SESSION_ID), "006", "рабочее дерево важнее tie-break");

  // Reviewer/verifier не владельцы карточки — задачи не присваиваем.
  assert.equal(findOwnedTask(root, "session-reviewer"), null);
});
