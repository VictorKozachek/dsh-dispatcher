/**
 * Панель: доска и расход токенов (задача 045).
 *
 * Читаем фикстуры карточек `.kanban/tasks/*.md`, проверяем счётчики по
 * колонкам, «залипшие» карточки, суммы токенов по задачам/периодам, отсутствие
 * доски (без падения) и то, что панель ничего не пишет в `.kanban`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOARD_STATUSES,
  boardSummary,
  collectBoard,
  panelSnapshot,
  parseCardFrontMatter,
  readBoardCards,
} from "../lib/panel.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");

const NOW = Date.UTC(2026, 10, 11, 18, 0, 0); // 2026-11-11T18:00:00Z
const MINUTE = 60 * 1000;

function tempWorkspace(t, prefix = "panel-board-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function card({ id, title = "Задача", status = "todo", role = "worker", since, updated, tokens, tokensByRole = {} }) {
  const lines = ["---", `id: "${id}"`, `title: "${title}"`, `status: ${status}`, `role: ${role}`];
  if (since !== undefined) lines.push(`since: ${new Date(since).toISOString()}`);
  if (updated !== undefined) lines.push(`updated: ${new Date(updated).toISOString()}`);
  if (tokens !== undefined) lines.push(`tokens: ${tokens}`);
  for (const [roleName, value] of Object.entries(tokensByRole)) lines.push(`tokens_${roleName}: ${value}`);
  lines.push("---", "", "## Задача", "", "текст");
  return lines.join("\n");
}

function writeCards(root, cards) {
  const dir = path.join(root, ".kanban", "tasks");
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, text] of Object.entries(cards)) fs.writeFileSync(path.join(dir, `${id}.md`), text);
  return dir;
}

test("счётчики по колонкам, залипшие карточки и расход сходятся", (t) => {
  const root = tempWorkspace(t);
  writeCards(root, {
    "001": card({ id: "001", title: "В работе", status: "in-progress", since: NOW - 60 * MINUTE, updated: NOW, tokens: 100, tokensByRole: { worker: 100 } }),
    "002": card({ id: "002", title: "На ревью", status: "in-review", role: "reviewer", since: NOW - 10 * MINUTE, updated: NOW, tokens: 50, tokensByRole: { worker: 30, reviewer: 20 } }),
    "003": card({ id: "003", title: "Тесты", status: "testing", role: "verifier", since: NOW - 2 * 24 * 60 * MINUTE, updated: NOW - 2 * 24 * 60 * MINUTE, tokens: 200 }),
    "004": card({ id: "004", title: "Готова", status: "ready", role: "dispatcher", since: NOW - 40 * MINUTE, updated: NOW - 10 * 24 * 60 * MINUTE, tokens: 30 }),
    "005": card({ id: "005", title: "Заблокирована", status: "blocked", role: "worker", updated: NOW }),
    "006": card({ id: "006", title: "Слита", status: "merged", role: "worker", updated: NOW, tokens: 999 }),
  });

  const summary = boardSummary(root, { now: () => NOW, staleMinutes: 30 });

  assert.equal(summary.missing, false);
  assert.deepEqual(summary.counts, {
    "in-progress": 1,
    "in-review": 1,
    testing: 1,
    ready: 1,
    blocked: 1,
  });
  assert.deepEqual(Object.keys(summary.counts), [...BOARD_STATUSES]);
  assert.deepEqual(summary.stale.map((card) => card.id), ["003", "001", "004"], "залипли дольше 30 минут (включая ready), старые сверху");
  assert.equal(summary.stale.find((card) => card.id === "001").ageMinutes, 60);
  assert.equal(summary.stale.some((card) => card.id === "002"), false, "10 минут — не залипла");

  const spend = summary.spend;
  assert.equal(spend.total, 100 + 50 + 200 + 30 + 999, "сумма всех токенов карточек");
  assert.equal(spend.today, 100 + 50 + 999, "сегодня — по updated сегодня");
  assert.equal(spend.week, 100 + 50 + 200 + 999, "неделя — включая updated 2 дня назад");
  assert.deepEqual(spend.tasks.map((task) => task.id), ["006", "003", "001", "002", "004"], "по убыванию расхода");
  assert.deepEqual(spend.tasks.find((task) => task.id === "002").tokensByRole, { worker: 30, reviewer: 20 });
});

test("токены без общего tokens считаются по tokens_<роль>", (t) => {
  const root = tempWorkspace(t);
  writeCards(root, {
    "010": card({ id: "010", status: "in-progress", updated: NOW, tokensByRole: { worker: 40, reviewer: 2 } }),
  });

  const summary = boardSummary(root, { now: () => NOW });

  assert.equal(summary.spend.total, 42);
  assert.equal(summary.spend.tasks[0].tokens, 42);
});

test("нет доски — «нет данных», а не падение", (t) => {
  const root = tempWorkspace(t);
  const summary = boardSummary(root, { now: () => NOW });
  assert.equal(summary.missing, true);
  assert.deepEqual(summary.counts, Object.fromEntries(BOARD_STATUSES.map((status) => [status, 0])));
  assert.deepEqual(summary.stale, []);
  assert.equal(summary.spend.total, 0);

  const snapshot = panelSnapshot({ stateFile: path.join(root, "state.json"), logFile: path.join(root, "log.jsonl"), now: () => NOW, workspaces: [root] });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.board.available, false);
  assert.equal(snapshot.board.workspaces[0].missing, true);
  assert.equal(snapshot.spend.total, 0);
});

test("несколько воркспейсов: сводка по каждому и общая сумма", (t) => {
  const first = tempWorkspace(t);
  const second = tempWorkspace(t);
  writeCards(first, { "020": card({ id: "020", status: "in-progress", updated: NOW, tokens: 10 }) });
  writeCards(second, { "021": card({ id: "021", status: "testing", role: "verifier", updated: NOW, tokens: 5 }) });

  const collected = collectBoard({ workspaces: [first, second], now: () => NOW, staleMinutes: 15 });

  assert.equal(collected.board.available, true);
  assert.equal(collected.board.workspaces.length, 2);
  assert.deepEqual(collected.board.workspaces.map((item) => item.name), [path.basename(first), path.basename(second)]);
  assert.equal(collected.board.staleMinutes, 15);
  assert.equal(collected.spend.total, 15);
  assert.deepEqual(collected.spend.tasks.map((task) => task.workspace), [path.basename(first), path.basename(second)]);
});

test("панель только читает .kanban: файлы не меняются", (t) => {
  const root = tempWorkspace(t);
  const tasksDir = writeCards(root, {
    "030": card({ id: "030", status: "in-progress", since: NOW - 60 * MINUTE, updated: NOW, tokens: 7 }),
  });
  const file = path.join(tasksDir, "030.md");
  const beforeText = fs.readFileSync(file, "utf8");
  const beforeStat = fs.statSync(file);

  panelSnapshot({ stateFile: path.join(root, "state.json"), logFile: path.join(root, "log.jsonl"), now: () => NOW, workspaces: [root] });
  boardSummary(root, { now: () => NOW });

  assert.equal(fs.readFileSync(file, "utf8"), beforeText, "содержимое карточки не изменилось");
  assert.equal(fs.statSync(file).mtimeMs, beforeStat.mtimeMs, "mtime карточки не изменился");
});

test("parseCardFrontMatter и readBoardCards терпимы к форме", (t) => {
  const front = parseCardFrontMatter('---\nid: "x"\ntokens: 12\ntokens_worker: "5"\n---\nbody');
  assert.deepEqual(front, { id: "x", tokens: "12", tokens_worker: "5" });

  const root = tempWorkspace(t);
  const dir = path.join(root, ".kanban", "tasks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bad.md"), "без фронт-маттера");
  fs.writeFileSync(path.join(dir, ".hidden.md"), card({ id: "hidden", tokens: 1 }));
  const result = readBoardCards(root);
  assert.equal(result.missing, false);
  assert.deepEqual(result.cards.map((item) => item.id), ["bad"], "скрытые и посторонние не считаются карточками с id");
});

test("panelSnapshot без воркспейсов не сканирует cwd и отдаёт пустую доску", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-empty-"));
  try {
    const snapshot = panelSnapshot({ stateFile: path.join(dir, "state.json"), logFile: path.join(dir, "log.jsonl") });
    assert.equal(snapshot.board.available, false);
    assert.deepEqual(snapshot.board.workspaces, []);
    assert.equal(snapshot.spend.total, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("метрики 031 попадают в расход, если хост их передал", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-metrics-"));
  try {
    const snapshot = panelSnapshot({
      stateFile: path.join(dir, "state.json"),
      logFile: path.join(dir, "log.jsonl"),
      metrics: { questions: { asked: 3 }, deliveries: { sent: 2 } },
    });
    assert.equal(snapshot.spend.metrics.questions.asked, 3);
    assert.equal(snapshot.spend.metrics.deliveries.sent, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("client.js рисует блоки доски и расхода", () => {
  const source = fs.readFileSync(path.join(pluginDir, "lib", "client.js"), "utf8");
  assert.match(source, /snapshot\.board|snapshot && snapshot\.board/, "доска в разметке");
  assert.match(source, /snapshot\.spend|snapshot && snapshot\.spend/, "расход в разметке");
  assert.match(source, /boardStale|stale-/);
  assert.match(source, /t\("board"\)/);
  assert.match(source, /t\("spend"\)/);
});
