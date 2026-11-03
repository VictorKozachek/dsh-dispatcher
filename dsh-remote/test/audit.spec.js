/**
 * Журнал решений по подтверждениям (задача 026).
 *
 * Проверяем обещания карточки: append-only JSONL, ротация по размеру, отсутствие
 * секретов и тел команд, устойчивость к пустому/битому файлу.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AUDIT_FILE_NAME,
  auditPaths,
  createAudit,
  redactSecrets,
  sanitizeEntry,
} from "../lib/audit.js";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function entry(overrides = {}) {
  return {
    kind: "approval",
    questionId: "approval-1",
    toolName: "Bash",
    callId: "call-42",
    outcome: "allowed-once",
    channel: "telegram",
    chatId: "42",
    answeredBy: "user-7",
    sessionId: "session-1",
    workspace: "/p",
    waitedMs: 4_000,
    decision: "remote",
    ...overrides,
  };
}

test("запись и чтение: JSONL, только разрешённые поля", (t) => {
  const dir = tempDir(t);
  const audit = createAudit({ file: path.join(dir, AUDIT_FILE_NAME), now: () => 1_700_000_000_000 });

  assert.equal(audit.append(entry({ reason: "rm -rf /tmp/project", command: "cat ~/.ssh/id_rsa" })), true);

  const file = path.join(dir, AUDIT_FILE_NAME);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "одно решение — одна строка");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.toolName, "Bash");
  assert.equal(parsed.decision, "remote");
  assert.equal(parsed.waitedMs, 4_000);
  assert.equal(parsed.ts, "2023-11-14T22:13:20.000Z");
  assert.equal("reason" in parsed, false, "причина не пишется");
  assert.equal("command" in parsed, false, "тело команды не пишется");
  assert.equal(fs.readFileSync(file, "utf8").includes("rm -rf"), false);

  assert.deepEqual(audit.tail(5), [parsed]);
  assert.deepEqual(audit.stats(), { total: 1, remote: 1, gui: 0, timeout: 0 });
});

test("секреты вычищаются даже из разрешённых полей", (t) => {
  const dir = tempDir(t);
  const audit = createAudit({ file: path.join(dir, AUDIT_FILE_NAME) });

  audit.append(entry({
    workspace: "/repo?token=SECRET-VALUE-123",
    answeredBy: "Bearer abc.def.ghi",
    toolName: "Bash 123456:TELEGRAM-BOT-TOKEN-SECRET",
    channel: "telegram",
  }));

  const text = fs.readFileSync(path.join(dir, AUDIT_FILE_NAME), "utf8");
  assert.equal(text.includes("SECRET-VALUE-123"), false, "токен в query не попал в журнал");
  assert.equal(text.includes("abc.def.ghi"), false, "Bearer не попал в журнал");
  assert.equal(text.includes("TELEGRAM-BOT-TOKEN-SECRET"), false, "токен бота не попал в журнал");
  assert.match(text, /<redacted>/);
});

test("sanitizeEntry: белый список, коды решений и исходов", () => {
  assert.equal(sanitizeEntry({ ts: "t", kind: "approval", decision: "remote" })?.decision, "remote");
  assert.equal(sanitizeEntry({ ts: "t", kind: "question", decision: "remote" }), null, "только подтверждения");
  assert.equal(sanitizeEntry({ ts: "t", kind: "approval", decision: "hacked" }), null);
  assert.equal(sanitizeEntry({ ts: "t", kind: "approval", decision: "gui", extra: "x" })?.extra, undefined);
  assert.equal(redactSecrets("api_key=SUPERSECRET").includes("SUPERSECRET"), false);
});

test("ротация по размеру: старый файл рядом, сводка видит оба", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, AUDIT_FILE_NAME);
  let clock = 1_700_000_000_000;
  const audit = createAudit({ file, maxBytes: 2_000, now: () => (clock += 1_000) });

  for (let index = 0; index < 20; index += 1) {
    audit.append(entry({ questionId: `approval-${index}`, decision: index % 3 === 0 ? "gui" : "remote" }));
  }

  assert.equal(fs.existsSync(`${file}.1`), true, "ротированный файл остался рядом");
  assert.ok(fs.statSync(file).size <= 2_000 + 400, "текущий файл не растёт бесконечно");
  assert.ok(fs.existsSync(`${file}.2`), "история хранится в нескольких файлах");
  assert.equal(audit.stats().total, 20, "сводка видит и ротированный файл");
  assert.equal(audit.stats().gui, 7, "решения не потерялись при ротации");
  assert.equal(audit.tail(3).length, 3, "хвост читается из обоих файлов");
  assert.equal(audit.tail(3)[2].questionId, "approval-19");
});

test("пустой и битый журнал не ломают чтение", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, AUDIT_FILE_NAME);

  const empty = createAudit({ file });
  assert.deepEqual(empty.tail(20), []);
  assert.deepEqual(empty.stats(), { total: 0, remote: 0, gui: 0, timeout: 0 });

  fs.writeFileSync(file, '{"ts":"t","kind":"approval","decision":"remote"}\nОБРЫВОК{');
  const broken = createAudit({ file });
  const entries = broken.tail(20);
  assert.equal(entries.length, 1, "валидная строка читается, битая пропускается");
  assert.equal(broken.stats().remote, 1);
});

test("append без decision отклоняется и не пишет строку", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, AUDIT_FILE_NAME);
  const audit = createAudit({ file });

  assert.equal(audit.append(entry({ decision: undefined })), false);
  assert.equal(fs.existsSync(file), false);
});

test("путь журнала: рядом со state.json, DSH_REMOTE_AUDIT главнее", () => {
  assert.equal(
    auditPaths({ env: { DSH_REMOTE_STATE: "/tmp/x/state.json" }, home: "/home/u" }).file,
    "/tmp/x/audit.jsonl",
  );
  assert.equal(
    auditPaths({ env: { DSH_REMOTE_AUDIT: "/tmp/audit.jsonl" }, home: "/home/u" }).file,
    "/tmp/audit.jsonl",
  );
});
