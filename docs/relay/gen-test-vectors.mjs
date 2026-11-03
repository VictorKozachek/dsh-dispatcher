#!/usr/bin/env node
/**
 * Генератор общих тест-векторов e2e (`docs/relay/test-vectors.json`).
 *
 * Запуск: node docs/relay/gen-test-vectors.mjs
 *
 * Ключи и nonce детерминированные (sha256 от метки), поэтому файл можно
 * перегенерировать и получить тот же результат — это и есть контракт совместимости
 * между JS, Kotlin и Swift реализациями. Тесты всех трёх реализаций читают один и
 * тот же файл.
 */

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CRYPTO_VERSION,
  createE2e,
  encodePublicKey,
  keyIdFor,
} from "../../dsh-remote/lib/crypto.js";

const here = dirname(fileURLToPath(import.meta.url));

const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

function privateKeyFromSeed(label) {
  return createHash("sha256").update(label).digest().toString("base64url");
}

function publicKeyFromPrivate(privateKeyBase64Url) {
  const raw = Buffer.from(privateKeyBase64Url, "base64url");
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  // SPKI для X25519: 12 байт префикса + 32 байта ключа.
  return encodePublicKey(spki.subarray(spki.length - 32));
}

function nonceFor(name) {
  return createHash("sha256").update(`${CRYPTO_VERSION}|${name}|nonce`).digest().subarray(0, 12);
}

const devicePrivate = privateKeyFromSeed("dsh-relay-e2e/device/1");
const pluginPrivate = privateKeyFromSeed("dsh-relay-e2e/plugin/1");
const devicePublic = publicKeyFromPrivate(devicePrivate);
const pluginPublic = publicKeyFromPrivate(pluginPrivate);
const keyId = keyIdFor(devicePublic);

/** Сторона плагина: шифрует вопросы, расшифровывает ответы. */
const pluginSide = createE2e({ privateKey: pluginPrivate, peerPublicKey: devicePublic, devicePublicKey: devicePublic });
/** Сторона устройства: расшифровывает вопросы, шифрует ответы (ключ тот же). */
const deviceSide = createE2e({
  privateKey: devicePrivate,
  peerPublicKey: pluginPublic,
  devicePublicKey: devicePublic,
});

function questionVector(name, alg, meta, plaintext) {
  const envelope = pluginSideFor(alg).sealQuestion(plaintext, meta, { nonce: nonceFor(name) });
  const opened = deviceSideFor(alg).openQuestion(envelope, meta);
  return {
    name,
    kind: "question",
    alg,
    meta,
    plaintext: opened,
    plaintextCanonical: canonicalQuestion(opened),
    nonce: envelope.nonce,
    envelope,
  };
}

function answerVector(name, alg, meta, plaintext) {
  const envelope = deviceSideFor(alg).sealAnswer(plaintext, meta, { nonce: nonceFor(name) });
  const opened = pluginSideFor(alg).openAnswer(envelope, meta);
  return {
    name,
    kind: "answer",
    alg,
    meta,
    plaintext: opened,
    plaintextCanonical: canonicalAnswer(opened),
    nonce: envelope.nonce,
    envelope,
  };
}

function pluginSideFor(alg) {
  return alg === pluginSide.alg ? pluginSide : createE2e({
    privateKey: pluginPrivate,
    peerPublicKey: devicePublic,
    devicePublicKey: devicePublic,
    alg,
  });
}

function deviceSideFor(alg) {
  return alg === deviceSide.alg ? deviceSide : createE2e({
    privateKey: devicePrivate,
    peerPublicKey: pluginPublic,
    devicePublicKey: devicePublic,
    alg,
  });
}

/**
 * Канонический JSON: только присутствующие поля, порядок фиксирован.
 * Любая реализация обязана сериализовать plaintext ровно так — иначе шифртекст
 * не совпадёт (байтовая совместимость и есть цель векторов).
 */
function canonicalQuestion(question) {
  const parts = [`"body":${JSON.stringify(question.body)}`];
  if (question.title !== undefined) parts.push(`"title":${JSON.stringify(question.title)}`);
  if (question.detail !== undefined) parts.push(`"detail":${JSON.stringify(question.detail)}`);
  if (question.options !== undefined) {
    const options = question.options
      .map((option) => `{"id":${JSON.stringify(option.id)},"label":${JSON.stringify(option.label)}}`)
      .join(",");
    parts.push(`"options":[${options}]`);
  }
  return `{${parts.join(",")}}`;
}

function canonicalAnswer(answer) {
  const parts = [];
  if (Array.isArray(answer.selected) && answer.selected.length > 0) {
    parts.push(`"selected":[${answer.selected.map((id) => JSON.stringify(id)).join(",")}]`);
  }
  if (answer.custom !== undefined) parts.push(`"custom":${JSON.stringify(answer.custom)}`);
  return `{${parts.join(",")}}`;
}

const questionMeta = {
  id: "b1e2c3d4-0000-4000-8000-000000000010",
  shortId: "a1b2c3d4",
  createdAt: "2026-11-03T18:00:00Z",
  expiresAt: "2026-11-03T18:30:00Z",
};

const answerMeta = {
  questionId: "b1e2c3d4-0000-4000-8000-000000000010",
  answeredAt: "2026-11-03T18:05:00Z",
  idempotencyKey: "3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60718",
};

const valid = [
  questionVector("question-options", "xchacha20poly1305", questionMeta, {
    body: "Продолжать?",
    title: "Вопрос агента",
    options: [
      { id: "o1", label: "Да" },
      { id: "o2", label: "Нет" },
    ],
  }),
  questionVector("question-detail", "xchacha20poly1305", questionMeta, {
    body: "Продолжать?",
    detail: "Проверка деталей вопроса",
  }),
  questionVector("question-emoji", "xchacha20poly1305", questionMeta, {
    body: "Запускать деплой? 🚀",
    title: "Деплой",
  }),
  questionVector("question-aes", "aes256gcm", questionMeta, {
    body: "Продолжать?",
    options: [{ id: "o1", label: "Да" }],
  }),
  answerVector("answer-selected", "xchacha20poly1305", answerMeta, { selected: ["o1"] }),
  answerVector("answer-custom", "aes256gcm", answerMeta, { custom: "ок, только без спешки" }),
  answerVector("answer-both", "xchacha20poly1305", answerMeta, {
    selected: ["o2"],
    custom: "через час",
  }),
];

const tampered = (vector) => ({
  ...vector.envelope,
  // Портим последний символ base64: тег перестаёт сходиться.
  enc: vector.envelope.enc.slice(0, -2) + (vector.envelope.enc.endsWith("=") ? "A=" : "AA"),
});

const invalid = [
  {
    name: "tampered-question",
    kind: "question",
    meta: questionMeta,
    envelope: tampered(valid[0]),
    error: "decrypt-failed",
  },
  {
    name: "aad-mismatch-question",
    kind: "question",
    meta: { ...questionMeta, expiresAt: "2026-11-03T19:00:00Z" },
    envelope: valid[0].envelope,
    error: "decrypt-failed",
  },
  {
    name: "wrong-key",
    kind: "question",
    meta: questionMeta,
    envelope: { ...valid[0].envelope, keyId: "dpk-AAAAAAAAAAAAAAAA" },
    error: "key-mismatch",
  },
  {
    name: "short-nonce",
    kind: "question",
    meta: questionMeta,
    envelope: { ...valid[0].envelope, nonce: Buffer.alloc(11).toString("base64") },
    error: "bad-envelope",
  },
  {
    name: "unknown-alg",
    kind: "question",
    meta: questionMeta,
    envelope: { ...valid[0].envelope, alg: "rot13" },
    error: "unsupported-alg",
  },
  {
    name: "bad-plainsize",
    kind: "question",
    meta: questionMeta,
    envelope: { ...valid[0].envelope, plainSize: valid[0].envelope.plainSize + 1 },
    error: "bad-envelope",
  },
];

const vectors = {
  version: 1,
  cryptoVersion: CRYPTO_VERSION,
  notes:
    "Общие векторы e2e (задача 021). Канонический plaintext и порядок полей описаны в docs/relay/CRYPTO.md §7. " +
    "Тесты JS, Kotlin и Swift читают этот файл и обязаны получить байт-в-байт те же конверты. " +
    "Ключи здесь ТЕСТОВЫЕ: сгенерированы из фиксированных сидов sha256, в продакшене не используются и " +
    "переиспользовать их нельзя.",
  keys: {
    device: { privateKey: devicePrivate, publicKey: devicePublic },
    plugin: { privateKey: pluginPrivate, publicKey: pluginPublic },
  },
  keyId,
  valid,
  invalid,
};

const target = join(here, "test-vectors.json");
writeFileSync(target, JSON.stringify(vectors, null, 2) + "\n", "utf8");
process.stdout.write(`записано ${valid.length} валидных и ${invalid.length} невалидных векторов → ${target}\n`);
