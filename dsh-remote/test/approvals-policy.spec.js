/**
 * Политика подтверждений (025): до канала, fail closed, таймаут = отказ.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DENY_REMOTE,
  DEFAULT_ON_TIMEOUT,
  DEFAULT_TTL_MS,
  DEFAULT_TOOLS,
  createApprovalPolicy,
  decide,
  describePolicy,
  normalizePolicy,
  timeoutOutcome,
  toolNameOf,
} from "../lib/approvals/policy.js";

const DANGEROUS = ["bash", "shell", "terminal", "exec", "run_command", "spawn", "git_push", "git_reset", "delete_file", "rm"];

test("по умолчанию безопасные инструменты удалённо можно, опасные — нельзя", () => {
  const policy = normalizePolicy(null);

  assert.deepEqual(policy.tools, [...DEFAULT_TOOLS]);
  assert.deepEqual(policy.denyRemote, [...DEFAULT_DENY_REMOTE]);
  assert.equal(policy.onTimeout, "cancelled");
  assert.equal(policy.ttlMs, DEFAULT_TTL_MS);

  // По умолчанию — только чтение: политика не видит путь и не может доказать,
  // что запись идёт «в свой воркспейс».
  for (const toolName of ["read_file", "list_files", "glob", "grep"]) {
    assert.equal(decide(policy, { toolName }).remote, true, `${toolName} можно`);
    assert.equal(decide(policy, { toolName }).reason, "allowed");
  }
  for (const toolName of ["write_file", "edit_file", "apply_patch", "create_file"]) {
    assert.equal(decide(policy, { toolName }).remote, false, `${toolName} по умолчанию нельзя`);
  }
  for (const toolName of DANGEROUS) {
    const decision = decide(policy, { toolName });
    assert.equal(decision.remote, false, `${toolName} нельзя удалённо`);
    assert.equal(decision.reason, "deny-remote");
  }
});

test("неизвестный инструмент и запрос без toolName отдаются GUI", () => {
  const policy = normalizePolicy(null);

  const unknown = decide(policy, { toolName: "some_new_tool_9000" });
  assert.equal(unknown.remote, false);
  assert.equal(unknown.reason, "tool-not-allowed");
  assert.match(unknown.message, /только в GUI/);

  const missing = decide(policy, { reason: "запрос без имени инструмента" });
  assert.equal(missing.remote, false);
  assert.equal(missing.reason, "unknown-tool");
});

test("denyRemote сильнее allowlist: инструмент в обоих списках — только GUI", () => {
  const policy = normalizePolicy({
    tools: ["read_file", "bash"],
    denyRemote: ["bash"],
  });

  assert.equal(decide(policy, { toolName: "read_file" }).remote, true);
  const bash = decide(policy, { toolName: "bash" });
  assert.equal(bash.remote, false);
  assert.equal(bash.reason, "deny-remote");
});

test("явный пустой allowlist: удалённо не подтверждаем ничего", () => {
  const policy = normalizePolicy({ tools: [] });
  assert.deepEqual(policy.tools, []);
  for (const toolName of ["read_file", "write_file"]) {
    assert.equal(decide(policy, { toolName }).remote, false);
  }
});

test("таймаут никогда не allowed-once: cancelled по умолчанию и unavailable по конфигу", () => {
  assert.equal(timeoutOutcome(normalizePolicy(null)), "cancelled");
  assert.equal(timeoutOutcome(normalizePolicy({})), "cancelled");
  assert.equal(timeoutOutcome(normalizePolicy({ onTimeout: "unavailable" })), "unavailable");
  assert.equal(timeoutOutcome(normalizePolicy({ onTimeout: "allowed-once" })), "cancelled", "опасное значение отвергнуто");
  assert.equal(timeoutOutcome(normalizePolicy({ onTimeout: "rejected" })), "cancelled");
  assert.equal(DEFAULT_ON_TIMEOUT, "cancelled");
});

test("битый конфиг не расширяет права: дефолты и TTL в допустимых границах", () => {
  const policy = normalizePolicy({
    tools: "read_file, write_file",
    denyRemote: [null, 42],
    onTimeout: "yes",
    ttlMs: "много",
  });

  assert.deepEqual(policy.tools, [...DEFAULT_TOOLS], "не-массив → дефолт");
  assert.deepEqual(policy.denyRemote, [...DEFAULT_DENY_REMOTE], "мусор в denyRemote → дефолт");
  assert.deepEqual(normalizePolicy({ tools: ["read_file", 123] }).tools, [...DEFAULT_TOOLS], "смешанный массив → дефолт, а не усечённый список");
  assert.equal(policy.onTimeout, "cancelled");
  assert.equal(policy.ttlMs, DEFAULT_TTL_MS);

  assert.equal(normalizePolicy({ ttlMs: 1_000 }).ttlMs, DEFAULT_TTL_MS, "меньше минуты не принимаем");
  assert.equal(normalizePolicy({ ttlMs: 5 * 60 * 1000 }).ttlMs, 5 * 60 * 1000);
  assert.equal(normalizePolicy({ ttlMs: 25 * 60 * 60 * 1000 }).ttlMs, DEFAULT_TTL_MS, "больше суток не принимаем");
});

test("toolNameOf понимает формы запроса DSH", () => {
  assert.equal(toolNameOf({ toolName: "read_file" }), "read_file");
  assert.equal(toolNameOf({ tool: { name: "write_file" } }), "write_file");
  assert.equal(toolNameOf({ name: "bash" }), "bash");
  assert.equal(toolNameOf({ tool: "grep" }), "grep");
  assert.equal(toolNameOf({}), null);
  assert.equal(toolNameOf(null), null);
});

test("describePolicy перечисляет списки и onTimeout для /remote status", () => {
  const lines = describePolicy(createApprovalPolicy({ tools: ["read_file"], denyRemote: ["bash"], onTimeout: "unavailable", ttlMs: 5 * 60 * 1000 }));
  assert.deepEqual(lines, [
    "approvals: tools=[read_file]",
    "approvals: denyRemote=[bash]",
    "approvals: onTimeout=unavailable (отказ), ttl=5 мин",
  ]);
});

test("createApprovalPolicy связывает решение, таймаут и описание", () => {
  const policy = createApprovalPolicy({ tools: ["read_file", "bash"], denyRemote: [], ttlMs: 120_000 });

  assert.equal(policy.decide({ toolName: "read_file" }).remote, true);
  // Явно пустой denyRemote + bash в allowlist — человек осознанно разрешил риск.
  assert.equal(policy.decide({ toolName: "bash" }).remote, true, "denyRemote пуст — решает allowlist");
  assert.equal(policy.decide({ toolName: "write_file" }).remote, false);
  assert.equal(policy.timeoutOutcome(), "cancelled");
  assert.match(policy.describe().join("\n"), /ttl=2 мин/);
});
