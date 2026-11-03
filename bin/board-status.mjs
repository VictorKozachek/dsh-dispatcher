#!/usr/bin/env node
/**
 * Дамп доски: колонки, карточки, кто на них.
 *
 * Разбор карточек берётся из плагина (`dsh-kanban/lib/watcher-core.js`), поэтому
 * правила совпадают с доской в GUI. Карточки открытых задач лежат в ветке —
 * `worktrees/<id>/.kanban/tasks/<id>.md` — и помечаются как «в ветке».
 *
 * Запуск: bin/board-status.sh [--root DIR] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");

// Плагин доски ставится в профиль DSH, а не в проект: его библиотеку ищем рядом
// (если набор лежит внутри плагина), в профиле и по переменной окружения.
async function loadWatcherCore() {
  const home = process.env.HOME || "";
  const candidates = [
    process.env.DSH_KANBAN_PLUGIN && path.join(process.env.DSH_KANBAN_PLUGIN, "lib/watcher-core.js"),
    path.join(project, "dsh-kanban/lib/watcher-core.js"),
    path.join(home, ".dsh/profiles/web/node_modules/dsh-kanban/lib/watcher-core.js"),
    path.join(home, ".dsh/profiles/desktop/node_modules/dsh-kanban/lib/watcher-core.js"),
    path.join(home, ".dsh/profiles/node_modules/dsh-kanban/lib/watcher-core.js"),
    path.join(home, "projects/dsh-kanban/dsh-kanban/lib/watcher-core.js")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  throw new Error(
    `не найден плагин dsh-kanban (watcher-core.js); искал:\n  ${candidates.join("\n  ")}\n` +
      "поставьте плагин в профиль или задайте DSH_KANBAN_PLUGIN=/путь/к/dsh-kanban"
  );
}

const { isNewer, normalizeStatus, snapshotCards } = await loadWatcherCore();

const COLUMNS = [
  ["backlog", "бэклог"],
  ["todo", "нужно сделать"],
  ["in-progress", "в работе"],
  ["in-review", "ревью"],
  ["testing", "тестирование"],
  ["ready", "к слиянию"],
  ["merged", "слито"],
  ["blocked", "заблокировано"]
];

let target = project;
let asJson = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--root") {
    if (index + 1 >= args.length) {
      console.error("--root требует значения: --root DIR");
      process.exit(2);
    }
    if (String(args[index + 1]).startsWith("-")) {
      console.error("--root: значение начинается с «-» — похоже, путь забыт.");
      console.error("если путь правда начинается с дефиса, пишите --root=ПУТЬ");
      process.exit(2);
    }
    target = path.resolve(args[index + 1]);
    index += 1;
  } else if (args[index] === "--json") {
    asJson = true;
  } else if (args[index] === "-h" || args[index] === "--help") {
    console.log("Дамп доски: колонки, карточки и кто на них.");
    console.log("");
    console.log("  bin/board-status.sh              # доска текущего проекта");
    console.log("  bin/board-status.sh --json       # то же машинно");
    console.log("  bin/board-status.sh --root DIR   # доска другого проекта");
    process.exit(0);
  } else {
    console.error(`неизвестный аргумент: ${args[index]}`);
    process.exit(2);
  }
}

const tasksDir = path.join(target, ".kanban", "tasks");
if (!fs.existsSync(tasksDir)) {
  console.error(`нет каталога карточек: ${tasksDir}`);
  process.exit(1);
}

function readDir(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]);
}

const cards = new Map();
for (const [id, card] of snapshotCards(readDir(tasksDir))) cards.set(id, card);

// Карточки открытых задач: плагин обходит worktrees/<id> и берёт одноимённую карточку.
const worktreesDir = path.join(target, "worktrees");
if (fs.existsSync(worktreesDir)) {
  for (const name of fs.readdirSync(worktreesDir)) {
    const file = path.join(worktreesDir, name, ".kanban", "tasks", `${name}.md`);
    if (!fs.existsSync(file)) continue;
    const [entry] = snapshotCards([[`${name}.md`, fs.readFileSync(file, "utf8")]]).values();
    if (!entry) continue;
    entry.source = "worktree";
    // Правило то же, что на доске в GUI: свежая запись побеждает, при равенстве —
    // карточка из ветки. Иначе «работа уже в main, а worktree не убрали» показывал
    // бы старый статус.
    const existing = cards.get(entry.id);
    if (!existing || isNewer(entry, existing)) cards.set(entry.id, entry);
  }
}

// Статус нормализует общая с плагином функция: доска терпима к регистру,
// пробелам и синонимам, поэтому и дамп обязан быть.
const list = [...cards.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
for (const card of list) {
  card.column = normalizeStatus(card.status);
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        root: target,
        cards: list.map((card) => ({
          id: card.id,
          title: card.title,
          status: card.column,
          owner: card.owner ?? "",
          role: card.role ?? "",
          tokens: card.tokens ?? "",
          updated: card.updated ?? "",
          inWorktree: card.source === "worktree"
        }))
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.log(`доска: ${target} (карточек ${list.length})`);
console.log("");
for (const [status, label] of COLUMNS) {
  const ids = list.filter((card) => card.column === status).map((card) => `#${card.id}`);
  console.log(`  ${status.padEnd(12)} ${ids.length ? ids.join(", ") : "—"}${ids.length ? `  (${label})` : ""}`);
}
console.log("");
for (const card of list) {
  const who = [card.role, card.owner].filter(Boolean).join(" ");
  const marks = [card.source === "worktree" ? "в ветке" : "", who, card.tokens ? `tokens ${card.tokens}` : ""]
    .filter(Boolean)
    .join(", ");
  console.log(`  #${card.id} [${card.column}] ${card.title}${marks ? ` — ${marks}` : ""}`);
}
