/**
 * E2E-шифрование тела вопроса для релея (задача 021).
 *
 * Сервер видит только конверт (`enc`, `nonce`, `keyId`, `alg`, `plainSize`) и
 * метаданные вопроса (id, shortId, дедлайн, optionCount, флаги). Тело, заголовок,
 * пояснение, подписи вариантов и идентификаторы выбранных вариантов шифруются
 * один раз на устройстве и расшифровываются только на устройстве/в плагине.
 *
 * Криптография — только `node:crypto` (никаких новых зависимостей):
 *   - X25519 (ECDH) — ключ устройства из `POST /v1/devices` и ключ плагина;
 *   - HKDF-SHA256 — вывод подключей вопроса и ответа из общего секрета;
 *   - AEAD: ChaCha20-Poly1305 (имя на проводе `xchacha20poly1305`, как в схеме
 *     016/023) или AES-256-GCM (`aes256gcm`) — по возможностям платформы.
 *
 * Контракт (поля конверта, длина nonce 12 байт, лимиты) — `docs/relay/schema.json`;
 * как выводится ключ и что происходит при смене устройства — `docs/relay/CRYPTO.md`.
 *
 * Внимание к имени `xchacha20poly1305`: контракт фиксирует nonce ровно 12 байт,
 * поэтому на проводе это **ChaCha20-Poly1305 (IETF)**, а не XChaCha20 (у того
 * nonce 24 байта). Имя оставлено ради совместимости со схемой; обоснование — в
 * CRYPTO.md §5.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/** Версия схемы вывода ключа: попадает в salt HKDF и в AAD. */
export const CRYPTO_VERSION = "dsh-relay-e2e-v1";

/** Имена алгоритмов на проводе (см. `EncEnvelope.alg` в схеме 023). */
export const ALG_CHACHA20_POLY1305 = "xchacha20poly1305";
export const ALG_AES_256_GCM = "aes256gcm";
export const SUPPORTED_ALGS = Object.freeze([ALG_CHACHA20_POLY1305, ALG_AES_256_GCM]);
export const DEFAULT_ALG = ALG_CHACHA20_POLY1305;

/** Префикс публичного ключа на проводе: `base64:<стандартный base64>`. */
export const PUBLIC_KEY_PREFIX = "base64:";

/** Префикс `keyId`: отпечаток публичного ключа устройства. */
export const KEY_ID_PREFIX = "dpk-";

/** Контракт §6: nonce ровно 12 байт, `plainSize` ≤ 48 КиБ, `enc` ≤ 64 КиБ base64. */
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const MAX_PLAIN_BYTES = 48 * 1024;
export const MAX_ENC_CHARS = 64 * 1024;
export const MAX_BODY_CHARS = 4000;
export const MAX_DETAIL_CHARS = 2000;
export const MAX_TITLE_CHARS = 200;
export const MAX_OPTIONS = 10;
export const MAX_OPTION_LABEL_CHARS = 120;

/** Ошибка криптослоя: `code` — машинный, `message` — человеческий (без секретов). */
export class CryptoError extends Error {
  constructor(message, { code = "crypto-error", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CryptoError";
    this.code = code;
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

function toBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

/** Строгий base64: Node декодирует молча мусор, а нам нужна ошибка, а не пустой буфер. */
function fromBase64(text, { field = "поле" } = {}) {
  const value = String(text ?? "");
  if (value === "" || !BASE64_RE.test(value)) {
    throw new CryptoError(`${field}: ожидался стандартный base64`, { code: "bad-envelope" });
  }
  const decoded = Buffer.from(value, "base64");
  if (toBase64(decoded) !== value) {
    throw new CryptoError(`${field}: base64 не декодируется однозначно`, { code: "bad-envelope" });
  }
  return decoded;
}

function fromBase64Url(text, { field = "поле" } = {}) {
  const value = String(text ?? "");
  if (value === "" || !BASE64URL_RE.test(value)) {
    throw new CryptoError(`${field}: ожидался base64url`, { code: "bad-key" });
  }
  return Buffer.from(value, "base64url");
}

function assertAlg(alg) {
  if (!SUPPORTED_ALGS.includes(alg)) {
    throw new CryptoError(
      `alg: поддерживаются ${SUPPORTED_ALGS.join(" и ")}, получено ${String(alg)}`,
      { code: "unsupported-alg" },
    );
  }
}

/**
 * Сгенерировать пару ключей устройства/плагина.
 *
 * @returns {{privateKey: string, publicKey: string}} `privateKey` — 32 байта
 *   X25519 в base64url (секрет, в git и логи не попадает), `publicKey` — формат
 *   провода `base64:<...>` (уходит в `POST /v1/devices`).
 */
export function generateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  return {
    privateKey: Buffer.from(privateJwk.d, "base64url").toString("base64url"),
    publicKey: PUBLIC_KEY_PREFIX + toBase64(Buffer.from(publicJwk.x, "base64url")),
  };
}

/** Сырые 32 байта публичного ключа из формата провода (`base64:` или чистый base64). */
function rawPublicKey(publicKey) {
  const text = String(publicKey ?? "");
  if (text === "") throw new CryptoError("пустой публичный ключ устройства", { code: "bad-key" });
  const withoutPrefix = text.startsWith(PUBLIC_KEY_PREFIX)
    ? text.slice(PUBLIC_KEY_PREFIX.length)
    : text;
  const raw = fromBase64(withoutPrefix, { field: "publicKey" });
  if (raw.length !== 32) {
    throw new CryptoError(`публичный ключ X25519 должен быть 32 байта, а не ${raw.length}`, {
      code: "bad-key",
    });
  }
  return raw;
}

/** Публичный ключ для провода из сырых 32 байт. */
export function encodePublicKey(raw) {
  const bytes = Buffer.from(raw);
  if (bytes.length !== 32) {
    throw new CryptoError(`публичный ключ X25519 должен быть 32 байта, а не ${bytes.length}`, {
      code: "bad-key",
    });
  }
  return PUBLIC_KEY_PREFIX + toBase64(bytes);
}

/**
 * `keyId` — отпечаток публичного ключа устройства: обе стороны считают его из
 * одного и того же ключа, поэтому id стабилен и не требует отдельного поля на
 * проводе.
 */
export function keyIdFor(publicKey) {
  const digest = createHash("sha256").update(rawPublicKey(publicKey)).digest();
  return KEY_ID_PREFIX + digest.toString("base64url").slice(0, 16);
}

/**
 * X25519 в Node импортируется только из DER (JWK требует и `x`, и `d`, а возить
 * публичную половину рядом с приватной незачем). Префиксы — RFC 8410:
 * PKCS#8 для приватного ключа и SPKI для публичного.
 */
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function privateKeyObject(privateKeyBase64Url) {
  const raw = fromBase64Url(privateKeyBase64Url, { field: "privateKey" });
  if (raw.length !== 32) {
    throw new CryptoError(`приватный ключ X25519 должен быть 32 байта, а не ${raw.length}`, {
      code: "bad-key",
    });
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyObject(publicKey) {
  return createPublicKey({
    key: Buffer.concat([SPKI_X25519_PREFIX, rawPublicKey(publicKey)]),
    format: "der",
    type: "spki",
  });
}

function deriveKey(sharedSecret, keyId, purpose) {
  const bytes = Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.from(CRYPTO_VERSION, "utf8"),
      Buffer.from(`${purpose}|${keyId}`, "utf8"),
      32,
    ),
  );
  return bytes;
}

function cipherName(alg) {
  return alg === ALG_AES_256_GCM ? "aes-256-gcm" : "chacha20-poly1305";
}

function seal(alg, key, nonce, aad, plaintext) {
  const cipher = createCipheriv(cipherName(alg), key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

function open(alg, key, nonce, aad, sealed) {
  if (sealed.length < TAG_BYTES + 1) {
    throw new CryptoError("конверт короче тега аутентификации", { code: "decrypt-failed" });
  }
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv(cipherName(alg), key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new CryptoError(
      "конверт повреждён или подменён: тег не сошёлся (AAD и nonce проверены)",
      { code: "decrypt-failed", cause: error },
    );
  }
}

/** AAD вопроса: связывает конверт с метаданными, чтобы сервер не подменил их. */
export function questionAad(meta, { keyId, alg }) {
  const id = String(meta?.id ?? "");
  const shortId = String(meta?.shortId ?? "");
  const createdAt = String(meta?.createdAt ?? "");
  const expiresAt = String(meta?.expiresAt ?? "");
  return `${CRYPTO_VERSION}|question|${id}|${shortId}|${createdAt}|${expiresAt}|${keyId}|${alg}`;
}

/** AAD ответа: привязка к вопросу, времени ответа и ключу идемпотентности. */
export function answerAad(meta, { keyId, alg }) {
  const questionId = String(meta?.questionId ?? "");
  const answeredAt = String(meta?.answeredAt ?? "");
  const idempotencyKey = String(meta?.idempotencyKey ?? "");
  return `${CRYPTO_VERSION}|answer|${questionId}|${answeredAt}|${idempotencyKey}|${keyId}|${alg}`;
}

/**
 * Проверить конверт по контракту 016/023 и вернуть разобранные байты.
 *
 * @param {{enc: string, nonce: string, keyId: string, alg: string, plainSize: number}} envelope
 */
export function validateEnvelope(envelope) {
  if (envelope === null || typeof envelope !== "object") {
    throw new CryptoError("конверт должен быть объектом", { code: "bad-envelope" });
  }
  const alg = envelope.alg;
  assertAlg(alg);
  const keyId = String(envelope.keyId ?? "");
  if (keyId.length < 4 || keyId.length > 64) {
    throw new CryptoError("keyId: ожидалось 4..64 символа", { code: "bad-envelope" });
  }
  const nonce = fromBase64(envelope.nonce, { field: "nonce" });
  if (nonce.length !== NONCE_BYTES) {
    throw new CryptoError(`nonce: ровно ${NONCE_BYTES} байт (${toBase64(nonce)} = ${nonce.length})`, {
      code: "bad-envelope",
    });
  }
  const encText = String(envelope.enc ?? "");
  if (encText.length > MAX_ENC_CHARS) {
    throw new CryptoError(`enc: не больше ${MAX_ENC_CHARS} символов base64`, {
      code: "payload-too-large",
    });
  }
  const enc = fromBase64(encText, { field: "enc" });
  if (enc.length < TAG_BYTES + 1) {
    throw new CryptoError("enc: пустой конверт", { code: "bad-envelope" });
  }
  const plainSize = envelope.plainSize;
  if (!Number.isInteger(plainSize) || plainSize < 0 || plainSize > MAX_PLAIN_BYTES) {
    throw new CryptoError(`plainSize: ожидалось целое 0..${MAX_PLAIN_BYTES}`, {
      code: "bad-envelope",
    });
  }
  return { enc, nonce, keyId, alg, plainSize };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateQuestionPlaintext(value) {
  if (!isPlainObject(value)) {
    throw new CryptoError("тело вопроса: ожидался JSON-объект", { code: "bad-plaintext" });
  }
  const { body, title, detail, options } = value;
  if (typeof body !== "string" || body.trim() === "") {
    throw new CryptoError("тело вопроса: нужен непустой body", { code: "bad-plaintext" });
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new CryptoError(`тело вопроса: body длиннее ${MAX_BODY_CHARS} символов`, {
      code: "payload-too-large",
    });
  }
  if (title !== undefined && (typeof title !== "string" || title.length > MAX_TITLE_CHARS)) {
    throw new CryptoError(`тело вопроса: title — строка до ${MAX_TITLE_CHARS} символов`, {
      code: "bad-plaintext",
    });
  }
  if (detail !== undefined && (typeof detail !== "string" || detail.length > MAX_DETAIL_CHARS)) {
    throw new CryptoError(`тело вопроса: detail — строка до ${MAX_DETAIL_CHARS} символов`, {
      code: "bad-plaintext",
    });
  }
  if (options !== undefined) {
    if (!Array.isArray(options) || options.length > MAX_OPTIONS) {
      throw new CryptoError(`тело вопроса: options — массив до ${MAX_OPTIONS} штук`, {
        code: "bad-plaintext",
      });
    }
    for (const option of options) {
      if (!isPlainObject(option) || typeof option.id !== "string" || typeof option.label !== "string") {
        throw new CryptoError("тело вопроса: вариант должен быть {id, label}", { code: "bad-plaintext" });
      }
      if (option.id === "" || option.id.length > 8 || option.label.length > MAX_OPTION_LABEL_CHARS) {
        throw new CryptoError("тело вопроса: id варианта 1..8, подпись до 120 символов", {
          code: "bad-plaintext",
        });
      }
    }
  }
  return {
    body,
    ...(title === undefined ? {} : { title }),
    ...(detail === undefined ? {} : { detail }),
    ...(options === undefined ? {} : { options: options.map(({ id, label }) => ({ id, label })) }),
  };
}

function validateAnswerPlaintext(value) {
  if (!isPlainObject(value)) {
    throw new CryptoError("тело ответа: ожидался JSON-объект", { code: "bad-plaintext" });
  }
  const selected = value.selected === undefined ? [] : value.selected;
  const custom = value.custom;
  if (!Array.isArray(selected) || selected.length > MAX_OPTIONS) {
    throw new CryptoError("тело ответа: selected — массив до 10 id", { code: "bad-plaintext" });
  }
  for (const id of selected) {
    if (typeof id !== "string" || id === "" || id.length > 8) {
      throw new CryptoError("тело ответа: id варианта — строка 1..8", { code: "bad-plaintext" });
    }
  }
  if (custom !== undefined && (typeof custom !== "string" || custom.length > MAX_BODY_CHARS)) {
    throw new CryptoError(`тело ответа: custom — строка до ${MAX_BODY_CHARS}`, {
      code: "bad-plaintext",
    });
  }
  if (selected.length === 0 && (custom === undefined || custom.trim() === "")) {
    throw new CryptoError("тело ответа: нужен выбранный вариант или текст", { code: "bad-plaintext" });
  }
  return {
    ...(selected.length === 0 ? {} : { selected }),
    ...(custom === undefined ? {} : { custom }),
  };
}

/**
 * Криптослой для одной пары «плагин ↔ устройство».
 *
 * @param {object} options
 * @param {string} options.privateKey — приватный ключ X25519 (base64url, 32 байта).
 * @param {string} options.peerPublicKey — публичный ключ собеседника в формате провода.
 * @param {string} [options.alg] — алгоритм для **шифрования** (открытие выбирает по конверту).
 * @param {string} [options.devicePublicKey] — публичный ключ устройства: из него
 *   считается `keyId`. По умолчанию — `peerPublicKey` (сторона плагина: устройство
 *   и есть собеседник). Сторона устройства передаёт свой публичный ключ явно.
 * @param {string} [options.keyId] — переопределить keyId.
 */
export function createE2e({
  privateKey,
  peerPublicKey,
  devicePublicKey = peerPublicKey,
  alg = DEFAULT_ALG,
  keyId = null,
} = {}) {
  assertAlg(alg);
  const peerRaw = rawPublicKey(peerPublicKey);
  const sharedSecret = diffieHellman({
    privateKey: privateKeyObject(privateKey),
    publicKey: publicKeyObject(encodePublicKey(peerRaw)),
  });
  const ownKeyId =
    typeof keyId === "string" && keyId !== "" ? keyId : keyIdFor(encodePublicKey(rawPublicKey(devicePublicKey)));
  const questionKey = deriveKey(sharedSecret, ownKeyId, "question");
  const answerKey = deriveKey(sharedSecret, ownKeyId, "answer");

  function sealWith(algName, key, aad, plaintext, { nonce } = {}) {
    const nonceBytes = nonce === undefined ? randomBytes(NONCE_BYTES) : Buffer.from(nonce);
    if (nonceBytes.length !== NONCE_BYTES) {
      throw new CryptoError(`nonce должен быть ${NONCE_BYTES} байт`, { code: "bad-envelope" });
    }
    const sealed = seal(algName, key, nonceBytes, aad, Buffer.from(plaintext, "utf8"));
    const plainSize = Buffer.byteLength(plaintext, "utf8");
    if (plainSize > MAX_PLAIN_BYTES) {
      throw new CryptoError(`открытый текст больше ${MAX_PLAIN_BYTES} байт`, {
        code: "payload-too-large",
      });
    }
    return {
      enc: toBase64(sealed),
      nonce: toBase64(nonceBytes),
      keyId: ownKeyId,
      alg: algName,
      plainSize,
    };
  }

  return {
    keyId: ownKeyId,
    alg,

    /** Зашифровать тело вопроса; метаданные — те же, что уйдут открыто в `Question`. */
    sealQuestion(question, meta, options = {}) {
      const plaintext = JSON.stringify(validateQuestionPlaintext(question));
      const aad = questionAad(meta, { keyId: ownKeyId, alg });
      return sealWith(alg, questionKey, aad, plaintext, options);
    },

    /** Расшифровать тело вопроса (сторона устройства). */
    openQuestion(envelope, meta) {
      const parsedEnvelope = validateEnvelope(envelope);
      if (parsedEnvelope.keyId !== ownKeyId) {
        throw new CryptoError(
          `вопрос зашифрован для другого ключа: ${parsedEnvelope.keyId} ≠ ${ownKeyId}`,
          { code: "key-mismatch" },
        );
      }
      const plain = open(
        parsedEnvelope.alg,
        questionKey,
        parsedEnvelope.nonce,
        questionAad(meta, { keyId: parsedEnvelope.keyId, alg: parsedEnvelope.alg }),
        parsedEnvelope.enc,
      );
      assertPlainSize(plain, parsedEnvelope.plainSize);
      return validateQuestionPlaintext(JSON.parse(plain.toString("utf8")));
    },

    /** Зашифровать ответ человека (сторона устройства). */
    sealAnswer(answer, meta, options = {}) {
      const plaintext = JSON.stringify(validateAnswerPlaintext(answer));
      const aad = answerAad(meta, { keyId: ownKeyId, alg });
      return sealWith(alg, answerKey, aad, plaintext, options);
    },

    /** Расшифровать ответ человека (сторона плагина). */
    openAnswer(envelope, meta) {
      const parsedEnvelope = validateEnvelope(envelope);
      if (parsedEnvelope.keyId !== ownKeyId) {
        throw new CryptoError(
          `ответ зашифрован для другого ключа: ${parsedEnvelope.keyId} ≠ ${ownKeyId}`,
          { code: "key-mismatch" },
        );
      }
      const plain = open(
        parsedEnvelope.alg,
        answerKey,
        parsedEnvelope.nonce,
        answerAad(meta, { keyId: parsedEnvelope.keyId, alg: parsedEnvelope.alg }),
        parsedEnvelope.enc,
      );
      assertPlainSize(plain, parsedEnvelope.plainSize);
      return validateAnswerPlaintext(JSON.parse(plain.toString("utf8")));
    },
  };
}

function assertPlainSize(plain, declared) {
  if (plain.length !== declared) {
    throw new CryptoError(
      `plainSize не совпал с расшифрованным телом: ${plain.length} ≠ ${declared}`,
      { code: "bad-envelope" },
    );
  }
}
