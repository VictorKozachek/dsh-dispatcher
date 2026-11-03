/**
 * RUNBOOK и мониторинг (задача 036).
 *
 * Машинная проверка обещания «у каждого doctor-кода fail есть раздел в RUNBOOK»:
 * список fail-кодов берётся из кода (`DOCTOR_FAIL_IDS`), маркеры — из
 * `docs/RUNBOOK.md`. Плюс SLO и обязательные инциденты из карточки.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_KEEP_ROTATED, DEFAULT_MAX_BYTES as AUDIT_MAX_BYTES } from "../lib/audit.js";
import { DOCTOR_FAIL_IDS } from "../lib/doctor.js";
import { DEFAULT_LOG_KEEP, DEFAULT_LOG_MAX_BYTES } from "../lib/reliability.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.dirname(testDir);
const runbookPath = path.resolve(packageDir, "..", "docs", "RUNBOOK.md");

function readRunbook() {
  return fs.readFileSync(runbookPath, "utf8");
}

/** Разделы `### …` в порядке файла: заголовок → текст до следующего ###/##. */
function sections(text) {
  const result = [];
  const lines = text.split("\n");
  let current = null;
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      if (current !== null) result.push(current);
      current = { title: heading[1], lines: [] };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  if (current !== null) result.push(current);
  return result.map((section) => ({ title: section.title, body: section.lines.join("\n") }));
}

/** Маркеры `<!-- doctor-fail: id -->` и их разделы. */
function failMarkers(text) {
  const markers = [];
  for (const section of sections(text)) {
    for (const match of section.body.matchAll(/<!--\s*doctor-fail:\s*([a-z0-9_:.-]+)\s*-->/gi)) {
      markers.push({ id: match[1], section });
    }
  }
  return markers;
}

test("RUNBOOK существует и это документ, а не заглушка", () => {
  assert.ok(fs.existsSync(runbookPath), `нет ${runbookPath}`);
  const text = readRunbook();
  assert.ok(text.length > 3_000, "RUNBOOK содержательный");
  assert.match(text, /^# RUNBOOK/m, "есть заголовок");
});

test("каждый doctor-код fail из 030 покрыт разделом RUNBOOK (машинно)", () => {
  const text = readRunbook();
  const markers = failMarkers(text);

  const covered = [...new Set(markers.map((marker) => marker.id))].sort();
  assert.deepEqual(
    covered,
    [...DOCTOR_FAIL_IDS].sort(),
    "набор разделов RUNBOOK совпадает с fail-кодами doctor; добавь раздел и маркер для нового кода",
  );
  for (const id of DOCTOR_FAIL_IDS) {
    const found = markers.filter((marker) => marker.id === id);
    assert.equal(found.length, 1, `у ${id} ровно один раздел, а не ${found.length}`);
  }
});

test("у каждого инцидента есть симптомы → проверка → действие → профилактика", () => {
  const text = readRunbook();
  for (const { id, section } of failMarkers(text)) {
    const body = section.body;
    for (const part of ["Симптомы", "Быстрая проверка", "Действие", "Профилактика"]) {
      assert.ok(body.includes(part), `раздел ${id} («${section.title}») без «${part}»`);
    }
    assert.match(body, /\/remote doctor/, `раздел ${id} должен отправлять в /remote doctor`);
  }
});

test("обязательные инциденты из карточки описаны", () => {
  const text = readRunbook().toLowerCase();
  const required = [
    "бот молчит",
    "409 conflict",
    "диск заполнен",
    "битый `state.json`",
    "токен отозван",
    "релей недоступен",
    "вопрос висит",
  ];
  for (const phrase of required) {
    assert.ok(text.includes(phrase), `в RUNBOOK нет инцидента «${phrase}»`);
  }
});

test("SLO сформулированы и измеримы через /remote stats", () => {
  const text = readRunbook();
  assert.match(text, /SLO/);
  assert.match(text, /\/remote stats/);
  assert.match(text, /p95/);
  assert.match(text, /latency\.buckets/, "SLO по латентности ссылается на бакеты /remote stats --json");
  assert.match(text, /le:\s*2000/, "порог 2 с выражен через бакет гистограммы");
  assert.match(text, /pending/, "SLO про потерю вопросов при рестарте измерим по pending/doctor");
  assert.match(text, /deliveries/, "SLO про доставку измерим по deliveries");
});

// ---------------------------------------------------------------------------
// Числа ротации: доки не должны разъезжаться с кодом (033)
// ---------------------------------------------------------------------------

/** Человеческий размер так, как его пишут доки: «5 МиБ» / «512 КиБ». */
function human(bytes) {
  const mib = 1024 * 1024;
  if (bytes % mib === 0) return `${bytes / mib} МиБ`;
  return `${bytes / 1024} КиБ`;
}

function docText(relative) {
  return fs.readFileSync(path.resolve(packageDir, "..", relative), "utf8");
}

test("размеры и число ротированных журналов в доках совпадают с кодом", () => {
  const auditSize = human(AUDIT_MAX_BYTES);
  const logSize = human(DEFAULT_LOG_MAX_BYTES);
  assert.equal(auditSize, "5 МиБ", "канон аудита 5 МиБ");
  assert.equal(logSize, "512 КиБ", "канон лога 512 КиБ");
  assert.equal(DEFAULT_KEEP_ROTATED, 5);
  assert.equal(DEFAULT_LOG_KEEP, 5);

  // Доки переносят строки — сравниваем по схлопнутым пробелам.
  const flat = (text) => text.replace(/\s+/g, " ");
  const runbook = flat(docText("docs/RUNBOOK.md"));
  assert.ok(runbook.includes(`аудит — ${auditSize} × ${DEFAULT_KEEP_ROTATED}`), "RUNBOOK: аудит по коду");
  assert.ok(runbook.includes(`лог — ${logSize} × ${DEFAULT_LOG_KEEP}`), "RUNBOOK: лог по коду");

  const approvals = flat(docText("docs/approvals.md"));
  assert.ok(approvals.includes(`ротация по ${auditSize} × ${DEFAULT_KEEP_ROTATED}`), "approvals: аудит по коду");

  const readme = flat(docText("dsh-remote/README.md"));
  assert.ok(readme.includes(auditSize), "README: размер аудита");
  assert.ok(readme.includes(logSize), "README: размер лога");
  assert.ok(readme.includes(`**${DEFAULT_LOG_KEEP}**`), "README: число ротированных");

  for (const [name, text] of [
    ["RUNBOOK", runbook],
    ["approvals", approvals],
    ["README", readme],
  ]) {
    assert.equal(text.includes("256 КиБ"), false, `${name}: устаревший размер 256 КиБ`);
  }
});

test("RUNBOOK честно описывает битый state.json (запись не блокируется)", () => {
  const runbook = docText("docs/RUNBOOK.md");
  const section = sections(runbook).find((item) => item.title.toLowerCase().includes("битый `state.json`"));
  assert.ok(section, "раздел про битый state.json есть");
  assert.match(section.body, /запись\*\* не блокируется|не блокируется/i, "сказано, что запись не блокируется");
  assert.match(section.body, /заменит файл дефолтом|заменит.*дефолт/i, "описано, что запись заменит файл");
  assert.match(section.body, /сначала/i, "совет: сначала сохранить копию");
  // «Файл из будущего» — по-прежнему блокируется и не перезаписывается.
  assert.match(section.body, /не перезаписывает/i);
});
