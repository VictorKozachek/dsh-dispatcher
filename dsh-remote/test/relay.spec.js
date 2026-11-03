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
  "question.publish.request.json": "QuestionPublishRequest",
  "question.encrypted.json": "Question",
  "questions.list.response.json": "QuestionList",
  "answer.request.json": "AnswerRequest",
  "answer.encrypted.request.json": "AnswerRequest",
  "answer.response.json": "Answer",
  "event.message.json": "Event",
  "event.question-created.json": "Event",
  "health.response.json": "Health",
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
  // Код ошибки — открытый набор (ответы аддитивные), но докумен тирует unsupported-version.
  assert.equal(typeof schema.components.schemas.Error.properties.error.properties.code.pattern, "string");
});

test("front matter карточек задач не ломает контракт (дым): parseFrontMatter доступен", () => {
  // Косвенный дым: утилита совместима с ESM-тестами и не требует состояния.
  assert.equal(parseFrontMatter("---\nid: 1\n---\n").id, "1");
});

test("таблица эндпоинтов в PROTOCOL.md совпадает со схемой по методам", () => {
  const protocol = readText("PROTOCOL.md");
  const schema = loadSchema();
  const rows = [...protocol.matchAll(/^\| `(GET|POST|PUT|DELETE|PATCH) (\/v1\/[^`]+)`/gm)]
    .map((match) => ({ method: match[1].toLowerCase(), path: match[2].split("?")[0] }));

  const fromSchema = [];
  for (const [endpoint, methods] of Object.entries(schema.paths)) {
    for (const method of Object.keys(methods)) fromSchema.push(`${method} ${endpoint}`);
  }
  const fromDoc = rows.map((row) => `${row.method} ${row.path}`);
  assert.deepEqual([...fromDoc].sort(), [...fromSchema].sort(), "методы и пути совпадают");
});

test("обязательные поля сущностей совпадают с документацией", () => {
  const schema = loadSchema();
  const expected = {
    Device: ["deviceId", "platform", "createdAt"],
    DeviceCreateRequest: ["platform", "publicKey"],
    PairRequest: ["pairCode", "deviceId"],
    PairResponse: ["deviceToken", "device", "confirmedAt"],
    Question: ["id", "shortId", "createdAt", "expiresAt"],
    AnswerRequest: ["questionId", "answeredAt", "idempotencyKey"],
    Answer: ["questionId", "answeredAt", "idempotencyKey"],
    Event: ["type", "at"],
    Health: ["ok", "version", "at"],
    Error: ["error"],
  };
  for (const [name, required] of Object.entries(expected)) {
    assert.deepEqual([...schema.components.schemas[name].required].sort(), [...required].sort(), name);
  }
  const protocol = readText("PROTOCOL.md");
  // publicKey и confirmedAt документированы — их отсутствие в таблице и было расхождением.
  assert.match(protocol, /publicKey/);
  assert.match(protocol, /confirmedAt/);
});

test("ответы аддитивны: незнакомые поля, коды ошибок и типы событий принимаются", () => {
  const schema = loadSchema();
  const device = { ...readJson("device-create.response.json"), futureField: { nested: true } };
  assert.equal(validate(schema.components.schemas.Device, device, { root: schema }).ok, true, "Device: лишнее поле ок");

  const answer = { ...readJson("answer.response.json"), futureField: 1 };
  assert.equal(validate(schema.components.schemas.Answer, answer, { root: schema }).ok, true, "Answer: лишнее поле ок");

  const error = { error: { code: "brand-new-code", message: "новый код", retryable: false } };
  assert.equal(validate(schema.components.schemas.Error, error, { root: schema }).ok, true, "незнакомый error.code ок");

  const event = { type: "deploy.finished", at: "2026-11-03T18:00:00Z", payload: { ok: true } };
  assert.equal(validate(schema.components.schemas.Event, event, { root: schema }).ok, true, "незнакомый event.type ок");
});

test("запросы строгие: лишнее поле в запросе отвергается", () => {
  const schema = loadSchema();
  for (const [name, file] of [
    ["DeviceCreateRequest", "device-create.request.json"],
    ["PairRequest", "pair.request.json"],
    ["AnswerRequest", "answer.request.json"],
  ]) {
    const payload = { ...readJson(file), extra: true };
    const result = validate(schema.components.schemas[name], payload, { root: schema });
    assert.equal(result.ok, false, `${name}: лишнее поле должно отвергаться`);
    assert.match(result.errors.join("; "), /лишнее поле extra/);
  }
});

test("e2e: открытые поля в зашифрованных вопросах и ответах отсутствуют", () => {
  const schema = loadSchema();
  const question = readJson("question.encrypted.json");
  for (const field of ["body", "title", "detail", "options"]) {
    assert.equal(field in question, false, `в e2e-вопросе нет ${field}`);
  }
  assert.equal(question.optionCount, 2, "сервер видит только число вариантов");
  assert.equal(validate(schema.components.schemas.Question, question, { root: schema }).ok, true);

  const answer = readJson("answer.encrypted.request.json");
  for (const field of ["selected", "custom"]) {
    assert.equal(field in answer, false, `в e2e-ответе нет ${field}`);
  }
  assert.equal(validate(schema.components.schemas.AnswerRequest, answer, { root: schema }).ok, true);

  const leaks = [
    ["Question", { ...question, options: [{ id: "o1", label: "Да" }] }],
    ["Question", { ...question, title: "утечка" }],
    ["AnswerRequest", { ...answer, selected: ["o1"] }],
    ["AnswerRequest", { ...answer, custom: "утечка" }],
  ];
  for (const [name, payload] of leaks) {
    assert.equal(validate(schema.components.schemas[name], payload, { root: schema }).ok, false, `${name}: открытое поле вместе с enc`);
  }
});

test("каждая схема из paths покрыта хотя бы одним примером", () => {
  const schema = loadSchema();
  const covered = new Set(Object.values(VALID));
  for (const [endpoint, methods] of Object.entries(schema.paths)) {
    for (const [method, contract] of Object.entries(methods)) {
      for (const ref of [contract.request, contract.response]) {
        if (ref === null) continue;
        const name = ref.split("/").pop();
        assert.ok(covered.has(name), `${method.toUpperCase()} ${endpoint}: для ${name} нет примера`);
      }
    }
  }
});
