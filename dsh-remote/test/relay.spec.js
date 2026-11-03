/**
 * Контракт релея (задача 016): документ, схема и примеры согласованы.
 *
 * Тест без сети: читает `docs/relay/*` из рабочего дерева, валидирует примеры
 * подмножеством JSON Schema через `docs/relay/validate.mjs` и проверяет, что
 * каждый эндпоинт из PROTOCOL.md есть в схеме (и наоборот).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectRefs, loadSchema, validate } from "../../docs/relay/validate.mjs";
import { parseFrontMatter } from "../lib/notify.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.resolve(HERE, "../../docs/relay");

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(RELAY, "examples", file), "utf8"));
const readText = (file) => fs.readFileSync(path.join(RELAY, file), "utf8");

/** Какие примеры какой схемой проверяются. */
const VALID = {
  "device-create.request.json": "DeviceCreateRequest",
  "device-create.response.json": "Device",
  "pair.request.json": "PairRequest",
  "pair.response.json": "PairResponse",
  "questions.list.response.json": "QuestionList",
  "question.encrypted.json": "Question",
  "answer.request.json": "AnswerRequest",
  "answer.response.json": "Answer",
  "event.message.json": "Event",
  "error.response.json": "Error",
};

test("схема релея: загружается, версия 1, все $ref разрешаются", () => {
  const schema = loadSchema();
  assert.equal(schema.version, "1.0.0");
  assert.equal(schema.components.schemas.Version.const, 1);

  const refs = [...collectRefs(schema)];
  assert.ok(refs.length > 0, "схема использует $ref");
  for (const ref of refs) {
    assert.match(ref, /^#\/components\/schemas\//, `локальный $ref: ${ref}`);
    const name = ref.split("/").pop();
    assert.ok(schema.components.schemas[name], `схема ${name} есть`);
  }
});

test("каждый эндпоинт есть в PROTOCOL.md и в схеме (и наоборот)", () => {
  const protocol = readText("PROTOCOL.md");
  const schema = loadSchema();
  const documented = new Set(protocol.match(/\/v1\/[a-z]+(?:\/\{[a-z]+\})?/g) ?? []);
  const described = new Set(Object.keys(schema.paths));

  assert.deepEqual([...documented].sort(), [...described].sort(), "наборы эндпоинтов совпадают");
  for (const [endpoint, methods] of Object.entries(schema.paths)) {
    for (const [method, contract] of Object.entries(methods)) {
      if (contract.request !== null) {
        assert.ok(schema.components.schemas[contract.request.split("/").pop()], `${method.toUpperCase()} ${endpoint}: схема запроса`);
      }
      if (contract.response !== null) {
        assert.ok(schema.components.schemas[contract.response.split("/").pop()], `${method.toUpperCase()} ${endpoint}: схема ответа`);
      }
    }
  }
});

test("валидные примеры проходят схему", () => {
  const schema = loadSchema();
  for (const [file, schemaName] of Object.entries(VALID)) {
    const result = validate(schema.components.schemas[schemaName], readJson(file), { root: schema });
    assert.equal(result.ok, true, `${file}: ${result.errors.join("; ")}`);
  }
});

test("негативные примеры не проходят и объясняют причину", () => {
  const schema = loadSchema();
  const cases = [
    ["invalid/answer-extra-field.json", "AnswerRequest", /лишнее поле extra/],
    ["invalid/wrong-version.json", "PairRequest", /const 1/],
    ["invalid/broken-enc.json", "Question", /oneOf|длиной|enum/],
    ["invalid/question-unknown-field.json", "Question", /лишнее поле serverSecret/],
  ];
  for (const [file, schemaName, reason] of cases) {
    const result = validate(schema.components.schemas[schemaName], readJson(file), { root: schema });
    assert.equal(result.ok, false, `${file} должен быть отвергнут`);
    assert.ok(result.errors.length > 0);
    assert.match(result.errors.join("; "), reason, `${file}: ${result.errors.join("; ")}`);
  }
});

test("e2e-конверт: открытый текст и конверт не передаются вместе", () => {
  const schema = loadSchema();
  const question = readJson("question.encrypted.json");
  assert.equal(question.body, undefined, "в e2e-вопросе нет открытого тела");
  assert.equal(validate(schema.components.schemas.Question, question, { root: schema }).ok, true);

  const both = { ...question, body: "утечка" };
  const result = validate(schema.components.schemas.Question, both, { root: schema });
  assert.equal(result.ok, false, "body + enc одновременно — нарушение контракта");
});

test("что видит сервер при e2e: только конверт и метаданные", () => {
  const protocol = readText("PROTOCOL.md");
  const envelope = readJson("question.encrypted.json").enc;

  for (const field of ["enc", "nonce", "keyId", "alg", "plainSize"]) {
    assert.ok(field in envelope, `поле конверта ${field}`);
    assert.match(protocol, new RegExp(field), `PROTOCOL.md описывает ${field}`);
  }
  assert.match(protocol, /не видит/);
  assert.match(protocol, /Сервер видит/);
  // Сервер не должен получать ключ: в конверте нет полей key/plaintext.
  assert.equal("key" in envelope, false);
  assert.equal("plaintext" in envelope, false);
});

test("версия и совместимость зафиксированы", () => {
  const protocol = readText("PROTOCOL.md");
  const compatibility = readText("COMPATIBILITY.md");
  const schema = loadSchema();

  assert.match(protocol, /X-Relay-Version/);
  assert.match(protocol, /unsupported-version/);
  assert.match(compatibility, /аддитивн/i);
  assert.match(compatibility, /426 unsupported-version/);
  assert.match(compatibility, /Sunset/);
  assert.match(compatibility, /90 дней/);
  assert.equal(schema.components.schemas.Error.properties.error.properties.code.enum.includes("unsupported-version"), true);
});

test("front matter карточек задач не ломает контракт (дым): parseFrontMatter доступен", () => {
  // Косвенный дым: утилита совместима с ESM-тестами и не требует состояния.
  assert.equal(parseFrontMatter("---\nid: 1\n---\n").id, "1");
});
