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
import { fileURLToPath } from "node:url";

import {
  FREE_TEXT_OPTION,
  HEADER_LIMIT,
  MORE_OPTION,
  TASK_LINK_PREFIX,
  WORKSPACE_LIMIT,
  findOwnedTask,
  findOwnedTaskCard,
  formatTime,
  frontMatterField,
  renderBody,
  renderClock,
  renderHeader,
  renderHtml,
  renderRows,
  resolveContext,
  sessionTitleFromProjection,
  taskLinkHint,
  truncate,
  truncateLines,
  truncateWord,
  workspaceLabel,
  worktreeHint,
} from "../lib/present.js";
import { t } from "../lib/i18n.js";

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
  assert.deepEqual(missing, {
    sessionId: SESSION_ID, workspace: null, cwd: null, role: null, sessionTitle: null, taskId: null, branch: null, worktree: null,
  });

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
  assert.deepEqual(noSession, {
    sessionId: null, workspace: null, cwd: null, role: null, sessionTitle: null, taskId: null, branch: null, worktree: null,
  });
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
    "",
    t("present.buttonHint"),
  ].join("\n"));
});

test("renderBody: подсказка multiSelect", () => {
  const body = renderBody({ body: "Что берём?", multiSelect: true, createdAt: 0 }, { maxText: 4096 });

  assert.match(body, /Что берём\?/);
  assert.match(body, new RegExp(t("present.multiselectHint").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("renderBody: усечение под caps.maxText с честным маркером", () => {
  const long = "а".repeat(200);
  const body = renderBody({ body: long, createdAt: 0 }, { maxText: 80 });

  assert.ok(body.length <= 80, `длина ${body.length} больше предела`);
  assert.match(body, new RegExp(t("present.truncationMarker").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

  assert.deepEqual(rows.map((row) => row.map((button) => button.label)), [["Да"], ["Нет"], [t("present.freeTextLabel")]]);
  assert.deepEqual(rows[0][0], { label: "Да", kind: "option", optionId: "o1" });
  assert.deepEqual(rows.at(-1)[0], { label: t("present.freeTextLabel"), kind: "free", optionId: FREE_TEXT_OPTION });
  assert.equal(rows.at(-1)[0].kind, "free");
});

test("renderRows: 12 вариантов при maxOptions 8 — «Показать ещё» и усечение ряда", () => {
  const options = Array.from({ length: 12 }, (_, index) => ({ id: `o${index + 1}`, label: `Вариант ${index + 1}` }));

  const rows = renderRows({ options, allowFreeText: true }, { maxOptions: 8 });

  assert.equal(rows.length, 8, "больше восьми рядов не рисуем");
  assert.deepEqual(rows.map((row) => row[0].kind), [
    "option", "option", "option", "option", "option", "option", "more", "free",
  ]);
  assert.equal(rows[6][0].label, t("present.moreLabel"));
  assert.equal(rows.at(-1)[0].label, t("present.freeTextLabel"));
});

test("renderRows: без свободного ответа и без вариантов", () => {
  const noFree = renderRows({ options: [{ id: "o1", label: "Да" }], allowFreeText: false }, { maxOptions: 8 });
  assert.deepEqual(noFree.map((row) => row[0].kind), ["option"]);

  // 044: вопрос без вариантов — быстрые ответы, а не кнопка «Другой ответ…».
  const empty = renderRows({ options: [], allowFreeText: true }, { maxOptions: 8 });
  assert.deepEqual(empty.map((row) => row[0].label), ["Да", "Нет", "Отложить", "Решай сам"]);
  assert.deepEqual(empty.map((row) => row[0].kind), ["quick", "quick", "quick", "quick"]);
  assert.deepEqual(empty.map((row) => row[0].optionId), ["q1", "q2", "q3", "q4"]);

  const noFreeText = renderRows({ options: [], allowFreeText: false }, { maxOptions: 8 });
  assert.deepEqual(noFreeText, []);
});

test("renderRows: быстрые ответы настраиваются и выключаются", () => {
  const custom = renderRows({
    options: [],
    allowFreeText: true,
    quickReplies: [{ id: "q1", label: "Ок", text: "Хорошо" }],
  }, { maxOptions: 8 });
  assert.deepEqual(custom, [[{ label: "Ок", kind: "quick", optionId: "q1" }]]);

  const disabled = renderRows({ options: [], allowFreeText: true, quickReplies: [] }, { maxOptions: 8 });
  assert.deepEqual(disabled, [], "пустой набор — только текстовый ввод");

  const noButtons = renderRows({ options: [], allowFreeText: true }, { maxOptions: 8, inlineButtons: false });
  assert.deepEqual(noButtons, []);

  const limited = renderRows({ options: [], allowFreeText: true }, { maxOptions: 2 });
  assert.deepEqual(limited.map((row) => row[0].label), ["Да", "Нет"], "лимит рядов соблюдается");
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

test("044: подсказка при быстрых кнопках говорит про альтернативный текст", async () => {
  const { t: tr } = await import("../lib/i18n.js");
  const withQuick = (await import("../lib/present.js")).renderBody({ body: "Продолжать?", options: [] }, {});
  assert.match(withQuick, new RegExp(tr("present.quickReplyHint").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const disabled = (await import("../lib/present.js")).renderBody({ body: "Продолжать?", options: [], quickReplies: [] }, {});
  assert.match(disabled, new RegExp(tr("present.freeTextHint").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

/* ------------------- 047: формат сообщений и подсказок ------------------- */

const FIXED_NOW = new Date(2026, 10, 3, 17, 41).getTime();
const FIXED_DEADLINE = new Date(2026, 10, 3, 18, 11).getTime();
const SNAPSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "snapshots", "present");
const PROJECT = "/Users/victor/projects/dsh-dispatcher";
const WORKTREE = `${PROJECT}/worktrees/047`;

/** 30 строк «ответа агента» — длинный текст, который не влезает в сообщение. */
function longAnswer(lines = 30) {
  return Array.from({ length: lines }, (_, index) => `строка ${index + 1}: ${"подробность ".repeat(3).trimEnd()}`).join("\n");
}

/** Ответ с кодом и диффом: то, что обязано быть моноширинным. */
function codeAnswer() {
  return [
    "Проверь патч:",
    "",
    "```js",
    "if (a < b && c > d) {",
    '  return "x & y";',
    "}",
    "```",
    "",
    "--- a/dsh-remote/lib/x.js",
    "+++ b/dsh-remote/lib/x.js",
    "@@ -1,2 +1,2 @@",
    "-const old = 1;",
    "+const next = 2;",
  ].join("\n");
}

/** Типичные сообщения; их текст лежит снапшотами рядом с тестами. */
function snapshotMessages() {
  const caps = { maxText: 4096, maxOptions: 8 };
  return {
    "short-question.txt": renderBody({
      workspace: PROJECT,
      role: "worker",
      taskId: "007",
      body: "Удалить ветку task/007 после слияния?",
      options: [{ id: "o1", label: "Да" }, { id: "o2", label: "Нет" }],
      createdAt: FIXED_NOW,
      expiresAt: FIXED_DEADLINE,
      lang: "ru",
    }, caps),
    "long-question.txt": renderBody({
      workspace: PROJECT,
      role: "worker",
      taskId: "047",
      body: longAnswer(),
      allowFreeText: true,
      createdAt: FIXED_NOW,
      lang: "ru",
    }, { maxText: 320 }),
    "code-question.txt": renderBody({
      workspace: PROJECT,
      role: "worker",
      body: codeAnswer(),
      allowFreeText: true,
      createdAt: FIXED_NOW,
      lang: "ru",
    }, caps),
    "task-question.txt": renderBody({
      workspace: WORKTREE,
      role: "worker",
      taskId: "047",
      branch: "feature/047",
      worktree: WORKTREE,
      body: "Пуш в develop?",
      options: [{ id: "o1", label: "Да" }, { id: "o2", label: "Нет" }],
      createdAt: FIXED_NOW,
      lang: "ru",
    }, caps),
    "no-task-question.txt": renderBody({
      workspace: PROJECT,
      role: "verifier",
      body: "Задача в порядке?",
      options: [{ id: "o1", label: "Да" }, { id: "o2", label: "Нет" }],
      createdAt: FIXED_NOW,
      lang: "ru",
    }, caps),
    "code-html.txt": renderHtml(codeAnswer()),
  };
}

test("047: снапшоты типичных сообщений (короткий, длинный, код, с задачей, без)", () => {
  const messages = snapshotMessages();

  for (const [name, actual] of Object.entries(messages)) {
    const file = path.join(SNAPSHOT_DIR, name);
    if (process.env.UPDATE_SNAPSHOTS === "1") {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
      fs.writeFileSync(file, `${actual}\n`);
      continue;
    }
    assert.ok(fs.existsSync(file), `нет снапшота ${name} (обновить: UPDATE_SNAPSHOTS=1 node --test dsh-remote/test/present.spec.js)`);
    assert.equal(actual, fs.readFileSync(file, "utf8").replace(/\n$/, ""), `снапшот ${name} разошёлся с рендером`);
  }
  assert.equal(Object.keys(messages).length, 6, "набор типичных случаев не должен молча сокращаться");
});

test("047: длинный ответ режется по границе строки с честным маркером", () => {
  const body = renderBody({
    workspace: PROJECT,
    role: "worker",
    body: longAnswer(30),
    allowFreeText: false,
    createdAt: FIXED_NOW,
    lang: "ru",
  }, { maxText: 320 });

  assert.ok(body.length <= 320, `длина ${body.length} больше предела`);
  const tail = body.split("\n").at(-1);
  const match = /^…ещё (\d+) строк(?:а|и|ок)?$/.exec(tail);
  assert.ok(match !== null, `последняя строка не хвост «…ещё N строк»: ${JSON.stringify(tail)}`);
  const shown = body.split("\n").filter((line) => /^строка \d+:/.test(line)).length;
  assert.equal(shown + Number(match[1]), 30, "показанные и скрытые строки дают исходное число строк");
  assert.match(body, /▸ dsh-dispatcher · worker · 17:41/, "шапка остаётся целой");
});

test("047: одна слишком длинная строка режется прежним маркером, а не «ещё 1 строка»", () => {
  const out = truncateLines("а".repeat(300), 80, { lang: "ru" });

  assert.ok(out.length <= 80, `длина ${out.length} больше предела`);
  assert.ok(out.endsWith(t("present.truncationMarker")), `нет маркера обрезки: ${out.slice(-20)}`);
});

test("047: хвост усечения говорит на языке сообщения", () => {
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const ru = truncateLines(lines, 44, { lang: "ru" });
  const en = truncateLines(lines, 44, { lang: "en" });

  assert.match(ru, /…ещё \d+ стр(?:ока|оки|ок)$/);
  assert.match(en, /…\d+ more lines?$/);
  assert.ok(ru.length <= 44 && en.length <= 44, "лимит соблюдается");
  assert.equal(truncateLines("a\nb", 10, { lang: "ru" }), "a\nb", "короткий текст не трогаем");
});

test("047: шапка — короткий идентификатор ветки без дубля номера задачи", () => {
  assert.equal(
    renderHeader({ workspace: "dsh-dispatcher", taskId: "047", branch: "feature/047", role: "worker", now: FIXED_NOW }),
    "▸ dsh-dispatcher · task 047 · worker · 17:41",
    "feature/047 дублировал бы номер задачи",
  );
  assert.equal(
    renderHeader({ workspace: "dsh-dispatcher", taskId: "047", branch: "refs/heads/bug/047-timeout", role: "worker", now: FIXED_NOW }),
    "▸ dsh-dispatcher · task 047 · 047-timeout · worker · 17:41",
    "refs/heads снят, значимая часть ветки осталась",
  );
});

test("047: длинное имя проекта усекается по границе слова, шапка — одна строка", () => {
  const long = "dsh-dispatcher-очень-длинное-имя-проекта-2026";
  const header = renderHeader({
    workspace: long,
    taskId: "047",
    branch: "feature/047",
    role: "worker",
    now: FIXED_NOW,
    expiresAt: FIXED_DEADLINE,
  });
  const workspace = header.replace("▸ ", "").split(" · ")[0];

  assert.ok(header.length <= HEADER_LIMIT, `шапка ${header.length} > ${HEADER_LIMIT}`);
  assert.ok(workspace.endsWith("…"), "длинное имя усечено");
  const stem = workspace.slice(0, -1);
  assert.ok(long.startsWith(stem), "усечение — префикс исходного имени");
  assert.match(long.charAt(stem.length), /[\s._/-]/, `имя оборвано посреди слова: ${workspace}`);
});

test("047: ссылка на задачу — номер в шапке, дерево одной строкой в подсказке", () => {
  const body = renderBody({
    workspace: WORKTREE,
    role: "worker",
    taskId: "047",
    branch: "feature/047",
    worktree: WORKTREE,
    body: "Пуш в develop?",
    options: [{ id: "o1", label: "Да" }],
    createdAt: FIXED_NOW,
    lang: "ru",
  }, { maxText: 4096 });

  assert.equal(body.split("\n")[0], "▸ dsh-dispatcher · task 047 · worker · 17:41", "в шапке — проект и номер карточки");
  assert.match(body, new RegExp(`^${TASK_LINK_PREFIX} feature/047 · worktrees/047$`, "m"));
  assert.doesNotMatch(body, /\/Users\//, "абсолютный путь в сообщение не уходит");
  assert.ok(body.indexOf(TASK_LINK_PREFIX) > body.indexOf("Пуш в develop?"), "ссылка ниже тела, а не в нём");
});

test("047: подсказка ровно одна — кнопка при вариантах, текст без кнопок", () => {
  const button = t("present.buttonHint");
  const text = t("present.freeTextHint");
  const options = [{ id: "o1", label: "Да" }];

  const withOptions = renderBody({ body: "?", options, createdAt: 0 }, { maxText: 4096 });
  assert.ok(withOptions.includes(button), "варианты — просим нажать кнопку");
  assert.ok(!withOptions.includes(text), "«ответьте текстом» одновременно не показываем");

  const withoutButtons = renderBody({ body: "?", options, createdAt: 0 }, { maxText: 4096, inlineButtons: false });
  assert.ok(withoutButtons.includes(text), "кнопок нет — только текст");
  assert.ok(!withoutButtons.includes(button), "не просим нажать несуществующую кнопку");

  const freeText = renderBody({ body: "?", quickReplies: [], createdAt: 0 }, { maxText: 4096 });
  assert.ok(freeText.includes(text));
  assert.ok(!freeText.includes(button));
});

test("047: caps.maxText соблюдается на любом теле — обрезка не рвёт лимит", () => {
  for (const maxText of [40, 80, 120, 300]) {
    const out = renderBody({
      workspace: "/p/dsh-dispatcher",
      role: "worker",
      body: longAnswer(50),
      allowFreeText: true,
      createdAt: FIXED_NOW,
      lang: "ru",
    }, { maxText });
    assert.ok(out.length <= maxText, `maxText=${maxText}: получили ${out.length}`);
  }
});

test("047: renderHtml экранирует текст, а код и дифф держит в <pre>", () => {
  assert.equal(renderHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  assert.equal(renderHtml("`x < y`"), "<code>x &lt; y</code>");

  const html = renderHtml(codeAnswer());
  assert.equal((html.match(/<pre>/g) ?? []).length, 2, "код и дифф — два моноширинных блока");
  assert.equal((html.match(/<\/pre>/g) ?? []).length, 2, "все блоки закрыты");
  assert.match(html, /<pre>if \(a &lt; b &amp;&amp; c &gt; d\) \{/);
  assert.match(html, /<pre>--- a\/dsh-remote\/lib\/x\.js/);
  assert.doesNotMatch(html, /<script|onerror=/i, "чужой html не проходит как разметка");
});

test("047: worktreeHint/workspaceLabel — короткий путь дерева, проект без номера задачи", () => {
  assert.equal(truncateWord("короткое", 20), "короткое");
  assert.ok(truncateWord("dsh-dispatcher-очень-длинное-имя", 20).endsWith("…"), "длинное усекается");
  assert.equal(worktreeHint(WORKTREE), "worktrees/047");
  assert.equal(worktreeHint(`${WORKTREE}/`), "worktrees/047");
  assert.equal(worktreeHint(null), null);
  assert.equal(workspaceLabel(WORKTREE), "dsh-dispatcher", "в шапке имя проекта, а не номер задачи");
  assert.equal(workspaceLabel(PROJECT), "dsh-dispatcher");
  assert.equal(workspaceLabel(""), null);
});

test("047: taskLinkHint — ветка и дерево одной строкой, без задачи — null", () => {
  assert.equal(taskLinkHint({}), null);
  assert.equal(taskLinkHint({ branch: "feature/047" }), `${TASK_LINK_PREFIX} feature/047`);
  assert.equal(
    taskLinkHint({ branch: "refs/heads/feature/047", worktree: "/p/x/worktrees/047" }),
    `${TASK_LINK_PREFIX} feature/047 · worktrees/047`,
  );
});

test("047: findOwnedTaskCard отдаёт ветку и дерево карточки", (t) => {
  const dir = tempWorkspace(t, {
    cards: {
      "006.md": [
        "---",
        'id: "006"',
        'title: "Задача 006"',
        "status: in-progress",
        `owner: ${SESSION_ID}`,
        "role: worker",
        'branch: "feature/006"',
        'worktree: "/Users/victor/projects/dsh-dispatcher/worktrees/006"',
        "---",
        "",
      ].join("\n"),
    },
  });

  assert.deepEqual(findOwnedTaskCard(dir, SESSION_ID), {
    id: "006",
    branch: "feature/006",
    worktree: "/Users/victor/projects/dsh-dispatcher/worktrees/006",
  });
  assert.equal(findOwnedTaskCard(dir, "session-other"), null);
  assert.equal(findOwnedTask(dir, SESSION_ID), "006", "findOwnedTask остаётся прежним API");
});

/** Снапшоты текста: правки формата видны в диффе (047). */
const snapshotsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "snapshots", "present");

function readSnapshot(name) {
  // Файл снапшота заканчивается переводом строки; сообщение — нет.
  return fs.readFileSync(path.join(snapshotsDir, name), "utf8").replace(/\n$/, "");
}

test("снапшоты: короткий, длинный, с кодом, с задачей, без задачи", () => {
  const createdAt = new Date(2026, 10, 3, 17, 41).getTime();
  const expiresAt = new Date(2026, 10, 3, 18, 11).getTime();
  const workspace = "/Users/victor/projects/dsh-dispatcher";
  const caps = { maxText: 4096, maxOptions: 8 };

  const shortQuestion = {
    workspace, role: "worker", taskId: "007", createdAt, expiresAt,
    body: "Удалить ветку task/007 после слияния?",
    options: [{ id: "o1", label: "Да" }],
  };
  assert.equal(renderBody(shortQuestion, caps), readSnapshot("short-question.txt"));

  const longBody = Array.from({ length: 30 }, (_, index) => `строка ${index + 1}: подробность подробность подробность`).join("\n");
  const longQuestion = { workspace, role: "worker", taskId: "047", createdAt, body: longBody };
  assert.equal(renderBody(longQuestion, { ...caps, maxText: 320 }), readSnapshot("long-question.txt"));

  const codeQuestion = {
    workspace, role: "worker", createdAt,
    body: [
      "Проверь патч:",
      "",
      "```js",
      "if (a < b && c > d) {",
      '  return "x & y";',
      "}",
      "```",
      "",
      "--- a/dsh-remote/lib/x.js",
      "+++ b/dsh-remote/lib/x.js",
      "@@ -1,2 +1,2 @@",
      "-const old = 1;",
      "+const next = 2;",
    ].join("\n"),
  };
  assert.equal(renderBody(codeQuestion, caps), readSnapshot("code-question.txt"));

  const taskQuestion = {
    workspace, role: "worker", taskId: "047",
    branch: "feature/047",
    worktree: "/Users/victor/projects/dsh-dispatcher/worktrees/047",
    createdAt,
    body: "Пуш в develop?",
    options: [{ id: "o1", label: "Да" }],
  };
  assert.equal(renderBody(taskQuestion, caps), readSnapshot("task-question.txt"));

  const noTaskQuestion = {
    workspace, role: "verifier", createdAt,
    body: "Задача в порядке?",
    options: [{ id: "o1", label: "Да" }],
  };
  assert.equal(renderBody(noTaskQuestion, caps), readSnapshot("no-task-question.txt"));
});

test("снапшот: код и диффы в <pre>, HTML экранирован", () => {
  const body = [
    "Проверь патч:",
    "",
    "```js",
    "if (a < b && c > d) {",
    '  return "x & y";',
    "}",
    "```",
    "",
    "--- a/dsh-remote/lib/x.js",
    "+++ b/dsh-remote/lib/x.js",
    "@@ -1,2 +1,2 @@",
    "-const old = 1;",
    "+const next = 2;",
  ].join("\n");

  assert.equal(renderHtml(body), readSnapshot("code-html.txt"));
});

test("HTML: спецсимволы экранируются, одиночные <pre> не ломаются", () => {
  const html = renderHtml("a < b & c > d `code <x>`");
  assert.equal(html, "a &lt; b &amp; c &gt; d <code>code &lt;x&gt;</code>");
  assert.equal(html.includes("<script>"), false);
});


function projectionHome(t, sessionId, title) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-title-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "storages", "session_projcache", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ record: { rows: { title: { val: title } } } }));
  return home;
}

test("068: имя сессии из кэша проекций попадает в шапку вместо пресета", (t) => {
  const home = projectionHome(t, SESSION_ID, "Оркестратор");
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const dir = tempWorkspace(t);
    const context = resolveContext({
      sessionId: SESSION_ID,
      ctx: fakeCtx({ get: () => session(dir, "standard") }),
    });
    assert.equal(context.role, "standard");
    assert.equal(context.sessionTitle, "Оркестратор");
    const body = renderBody({
      workspace: dir, role: context.role, sessionTitle: context.sessionTitle,
      body: "Продолжать?", createdAt: 0,
    }, { maxText: 4096 });
    assert.match(body.split("\n")[0], /Оркестратор/);
    assert.equal(body.split("\n")[0].includes("standard"), false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("068: API title предпочтительнее файла; без имени — пресет", (t) => {
  const home = projectionHome(t, SESSION_ID, "Из файла");
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const dir = tempWorkspace(t);
    const apiSession = { header: { cwd: dir, agentPreset: "standard", title: "Из API" } };
    const context = resolveContext({ sessionId: SESSION_ID, ctx: fakeCtx({ get: () => apiSession }) });
    assert.equal(context.sessionTitle, "Из API");
    assert.match(renderHeader({ workspace: "p", role: "standard", sessionTitle: context.sessionTitle }), /Из API/);
    assert.equal(renderHeader({ workspace: "p", role: "standard" }).includes("standard"), true, "без имени — пресет");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("068: битый кэш/нет файла — пресет и debug-лог, без падения", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-title-broken-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "storages", "session_projcache", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `session-${SESSION_ID}.json`), "{не json");
  const logs = [];
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const workspace = tempWorkspace(t);
    const context = resolveContext({
      sessionId: SESSION_ID,
      ctx: fakeCtx({ get: () => session(workspace, "standard") }),
      log: (line) => logs.push(line),
    });
    assert.equal(context.sessionTitle, null);
    assert.match(renderHeader({ workspace: "p", role: context.role }), /standard/);
    assert.ok(logs.some((line) => /invalid JSON/.test(line)));
    assert.equal(sessionTitleFromProjection("no-such-session", { env: { DSH_HOME: home } }), null);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("068: длинное имя усечено, HEADER_LIMIT соблюдён", (t) => {
  const long = "Очень длинное имя сессии оркестратора проекта";
  const home = projectionHome(t, SESSION_ID, long);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const workspace = tempWorkspace(t);
    const context = resolveContext({ sessionId: SESSION_ID, ctx: fakeCtx({ get: () => session(workspace, "standard") }) });
    const header = renderHeader({ workspace: "very-long-project-name", role: context.role, sessionTitle: context.sessionTitle, now: 0 });
    assert.ok(header.length <= HEADER_LIMIT, `длина ${header.length}`);
    assert.equal(header.includes("…"), true);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

// Fallback: по типам DSH Agent.id — это SessionId, и на обычном хосте
// session.id совпадает с request.agent.id; тест оставлен как защита для хостов,
// где sessions.get вернул объект с другим id, а не как покрытие живого случая.
test("069: имя находится по session.id, если request.agent.id — id агента", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-title-session-id-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "storages", "session_projcache", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session-real-1234.json"), JSON.stringify({
    record: { rows: { title: { val: "Оркестратор" } } },
  }));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const workspace = tempWorkspace(t);
    const ctx = fakeCtx({
      get: () => ({ id: "session-real-1234", header: { cwd: workspace, agentPreset: "standard" } }),
    });
    const context = resolveContext({ sessionId: "agent-abc", ctx });
    assert.equal(context.sessionTitle, "Оркестратор");
    assert.match(renderBody({ workspace, role: context.role, sessionTitle: context.sessionTitle, body: "x", createdAt: 0 }, { maxText: 4096 }).split("\n")[0], /Оркестратор/);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("069: context.resolve пишет безопасные факты foundTitle/preset", (t) => {
  const home = projectionHome(t, SESSION_ID, "Оркестратор");
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const workspace = tempWorkspace(t);
    const events = [];
    const journal = { record: (event, fields = {}) => { events.push({ event, ...fields }); return true; } };
    const context = resolveContext({
      sessionId: SESSION_ID,
      ctx: fakeCtx({ get: () => ({ id: "session-other-9999", header: { cwd: workspace, agentPreset: "standard" } }) }),
      journal,
    });
    assert.equal(context.sessionTitle, "Оркестратор");
    const entry = events.find((item) => item.event === "context.resolve");
    assert.ok(entry, "context.resolve записан");
    assert.equal(entry.detail.foundTitle, true);
    assert.equal(entry.detail.preset, "standard");
    assert.equal(entry.detail.sameId, false);
    assert.equal(entry.detail.titleSource, "agent-id");
    assert.equal(entry.detail.homeSource, "env");
    assert.equal(entry.detail.cacheDirExists, true);
    assert.equal(entry.detail.fileFoundByAgentId, true);
    assert.equal(entry.detail.hasTitleByAgentId, true);
    assert.equal(entry.detail.sessionId.includes(SESSION_ID), false, "полный id не пишется");
    assert.equal(entry.detail.sessionObjectId.includes("session-other-9999"), false);
    assert.match(entry.detail.sessionId, /…$/);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("069: без обоих id имени нет — пресет и foundTitle:false", (t) => {
  const events = [];
  const journal = { record: (event, fields = {}) => { events.push({ event, ...fields }); return true; } };
  const workspace = tempWorkspace(t);
  const context = resolveContext({
    sessionId: SESSION_ID,
    ctx: fakeCtx({ get: () => ({ header: { cwd: workspace, agentPreset: "reviewer" } }) }),
    journal,
  });
  assert.equal(context.sessionTitle, null);
  assert.equal(context.role, "reviewer");
  assert.match(renderHeader({ workspace: "p", role: context.role }), /reviewer/);
  const entry = events.find((item) => item.event === "context.resolve");
  assert.equal(entry.detail.foundTitle, false);
  assert.equal(entry.detail.sameId, null);
});

test("069: context.resolve пишется и при исключении sessions.get (без id)", () => {
  const events = [];
  const journal = { record: (event, fields = {}) => { events.push({ event, ...fields }); return true; } };
  const context = resolveContext({
    sessionId: SESSION_ID,
    ctx: { get: () => ({ get: () => { throw new Error("sessions недоступны"); } }) },
    journal,
  });
  assert.equal(context.sessionTitle, null);
  const entry = events.find((item) => item.event === "context.resolve");
  assert.ok(entry);
  assert.equal(entry.detail.foundTitle, false);
  assert.equal(entry.detail.sameId, null);
  assert.match(entry.detail.sessionId, /…$/);
});


test("069: маска разных session id различается (уникальная часть, не префикс)", (t) => {
  const events = [];
  const journal = { record: (event, fields = {}) => { events.push({ event, ...fields }); return true; } };
  const ctx = fakeCtx({ get: () => ({ header: { cwd: "/p", agentPreset: "standard" } }) });
  resolveContext({ sessionId: "session-8aac9774-1111", ctx, journal });
  resolveContext({ sessionId: "session-25c353d8-2222", ctx, journal });
  const masks = events.filter((entry) => entry.event === "context.resolve").map((entry) => entry.detail.sessionId);
  assert.equal(masks.length, 2);
  assert.notEqual(masks[0], masks[1], "метки должны различаться");
  assert.equal(masks[0].startsWith("session-"), false, "префикс не маскирует уникальную часть");
});

test("072: notify не предлагает «Другой ответ…», подсказка ведёт в GUI", () => {
  const question = {
    workspace: "/tmp/project",
    body: "Продолжать?",
    options: [{ id: "o1", label: "Да" }, { id: "o2", label: "Нет" }],
    allowFreeText: true,
    mirrorNotify: true,
  };
  const rows = renderRows(question, { maxOptions: 4, maxText: 4096 });
  assert.equal(rows.flat().some((row) => row.kind === "free"), false, "нет кнопки свободного текста");
  assert.equal(rows.flat().some((row) => row.kind === "option"), true, "варианты остаются");
  const body = renderBody(question, { maxText: 4096 });
  assert.match(body, /Ответьте в GUI/);
  assert.doesNotMatch(body, /Ответьте текстом/);
});

test("072: full/remote-only сохраняют «Другой ответ…» и текстовую подсказку", () => {
  const question = {
    workspace: "/tmp/project",
    body: "Продолжать?",
    options: [{ id: "o1", label: "Да" }],
    allowFreeText: true,
  };
  const rows = renderRows(question, { maxOptions: 4, maxText: 4096 });
  assert.equal(rows.flat().some((row) => row.kind === "free"), true);
  const body = renderBody(question, { maxText: 4096 });
  assert.match(body, /Нажмите кнопку/);
});
