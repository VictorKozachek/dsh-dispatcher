# Протокол релея DSH (v1)

Контракт между плагином `dsh-remote` и **своим** релеем: плагин публикует вопрос,
релей держит его до ответа человека, устройство (телефон) забирает вопрос и
возвращает ответ. При e2e-шифровании релей **не знает** содержимого: ни тела
вопроса, ни вариантов, ни ответа (см. §6).

Статус: черновик 1.0.0 (ноябрь 2026). Спека: `.kanban/specs/003.md`.
Машиночитаемая схема: [`schema.json`](schema.json) (JSON Schema 2020-12, подмножество).
Правила совместимости: [`COMPATIBILITY.md`](COMPATIBILITY.md).
Примеры: [`examples/`](examples) (валидируются тестом `dsh-remote/test/relay.spec.js`).

**Два режима — на каждую сущность ровно один:**

- **открытый**: тело и варианты видны серверу (`body`+`options` у вопроса,
  `selected`+`custom` у ответа);
- **e2e**: вместо них конверт `enc`, а открытые поля **отсутствуют** (схема
  запрещает их через `not`). Сервер видит только метаданные.

## 1. Сущности

| Сущность | Поля (обязательные — **жирным**) | Смысл |
|---|---|---|
| **Device** (ответ) | **deviceId**, **platform** (`ios`/`android`/`web`), **createdAt**; `pushToken?`, `label?` | Устройство человека. `deviceId` — uuid, выдаёт релей; `pushToken` — для пушей, не секрет. Ответ аддитивный. |
| **DeviceCreateRequest** | **platform**, **publicKey**; `pushToken?`, `label?` | Регистрация устройства. `publicKey` — публичный ключ устройства для e2e (base64; X25519/Ed25519), приватный ключ на сервер не попадает. |
| **Pairing** | **pairCode** (6 цифр), **deviceId**, **expiresAt**, **confirmed**; `confirmedAt?` | Привязка: плагин показывает код, человек вводит его на устройстве. Код живёт 10 минут и одноразовый. |
| **PairRequest / PairResponse** | request: **pairCode**, **deviceId**; response: **deviceToken**, **device**, **confirmedAt** | Подтверждение привязки: `deviceToken` — Bearer для устройства. |
| **Question** | **id** (uuid), **shortId** (8 hex), **createdAt**, **expiresAt**; открытый режим — **body**, **options** (`[{id,label}]`); e2e — **enc**; `workspace?`, `taskId?`, `role?`, `multiSelect?`, `allowFreeText?`, `optionCount?` | Вопрос агента. В e2e `body`/`title`/`detail`/`options` **не передаются**; `optionCount` даёт серверу число вариантов для лимитов. |
| **AnswerRequest / Answer** | **questionId**, **answeredAt**, **idempotencyKey**; открытый режим — **selected** (`string[]` — **id вариантов**, не подписи), `custom?`; e2e — **enc** | Ответ человека. `answeredBy` на проводе **нет**: устройство идентифицируется `deviceToken`; ответ аддитивный. `idempotencyKey` — uuid запроса. |
| **Event** | **type**, **at**; `questionId?`, `payload?` | Событие потока: `question.created`, `question.answered`, `question.expired`, `pairing.confirmed`, `device.revoked`, `heartbeat`. `type` — открытый набор: незнакомый тип клиент игнорирует. |
| **EncEnvelope** | **enc**, **nonce**, **keyId**, **alg**, **plainSize** | Конверт e2e: `enc` — base64(ciphertext), `nonce` — base64(12 байт), `keyId` — id ключа, `alg` — `xchacha20poly1305`/`aes256gcm`, `plainSize` — длина открытого текста. Сервер не имеет ключа. |
| **Error** | **error.code**, **error.message**; `error.retryable?`, `error.details?` | Ошибка. `code` — открытый набор (§5); незнакомый код клиент трактует как `internal`. |

**Строгость:** запросы (`DeviceCreateRequest`, `PairRequest`, `Question`,
`QuestionPublishRequest`, `AnswerRequest`) — `additionalProperties: false`: лишнее
поле = `400 bad-request`. Ответы (`Device`, `PairResponse`, `QuestionList`,
`Answer`, `Event`, `Health`, `Error`) — `additionalProperties: true`: незнакомые
поля клиент игнорирует (см. COMPATIBILITY §4).

## 2. Версия

- Версия в пути: **`/v1/...`**. Ломающие изменения — только `/v2` (старый живёт ≥90 дней после объявления, см. COMPATIBILITY).
- Каждый запрос несёт заголовок **`X-Relay-Version: 1`** (целое). Несовпадение мажорной версии — `426 Upgrade Required` с `error.code = "unsupported-version"` и списком поддерживаемых версий в `error.details.supported`.
- Ответы содержат заголовок `X-Relay-Version` текущей версии.

## 3. Эндпоинты

Все тела — `application/json; charset=utf-8`. Аутентификация — `Authorization: Bearer <deviceToken>` (кроме `POST /v1/devices` и `POST /v1/pair`); `deviceToken` выдаётся при подтверждении привязки. Плагин публикует вопросы с `Authorization: Bearer <agentToken>`.

| Метод и путь | Назначение | Запрос | Успех |
|---|---|---|---|
| `POST /v1/devices` | зарегистрировать устройство | `DeviceCreateRequest` | `201` + `Device` |
| `DELETE /v1/devices/{id}` | отозвать устройство (токен сразу недействителен) | — | `204` |
| `POST /v1/pair` | подтвердить привязку по `pairCode` | `PairRequest` | `200` + `PairResponse` |
| `POST /v1/questions` | опубликовать вопрос (плагин) | `QuestionPublishRequest` | `201` + `Question` |
| `GET /v1/questions?since=<rfc3339>&limit=<n>` | вопросы после `since` (курсор — `nextSince`) | — | `200` + `QuestionList` |
| `POST /v1/answers` | ответ человека; идемпотентно по `idempotencyKey` | `AnswerRequest` | `201` + `Answer`; повтор — `200` + тот же `Answer` |
| `GET /v1/answers?questionId=<id>` | ответ на вопрос (плагин) | — | `200` + `Answer` |
| `GET /v1/events` | поток событий: WebSocket upgrade; без upgrade — `426` | — | WS; текстовые кадры — `Event` |
| `GET /v1/health` | живость релея | — | `200` + `Health` |
| `POST /v1/heartbeat` | устройство живо (интервал 30 с) | — | `204` |

**Heartbeat/ping:** в WebSocket — ping-кадр каждые 25 с; если pong не пришёл за 10 с,
соединение закрывается кодом `1001`, клиент переподключается с экспоненциальной
паузой (1 с → 30 с, jitter).

## 4. Идемпотентность и ретраи

- `POST /v1/answers` идемпотентен по `idempotencyKey` (uuid): первый запрос — `201`,
  повтор с тем же телом — `200` и тот же `Answer`; повтор с **другим** телом и тем же
  ключом — `409 conflict`.
- `POST /v1/devices` идемпотентен по `(platform, publicKey)`: повтор возвращает
  существующее устройство (`200` вместо `201`).
- Повторять можно только `5xx`, `429` и сетевые ошибки; `4xx` (кроме `429`) — нет.
- Пауза между повторами: 1 с, 2 с, 4 с, 8 с, 16 с (максимум 5 попыток), с jitter.
- `429` содержит `Retry-After` (секунды); клиент уважает его.

## 5. Ошибки

Тело ошибки — `{"error": {"code": "...", "message": "...", "retryable": bool, "details"?: {}}}`.

| Код HTTP | `error.code` | Когда |
|---|---|---|
| `400` | `bad-request` | не проходит схема (лишние поля, неверный тип) |
| `401` | `unauthorized` | нет/просрочен `deviceToken` |
| `403` | `forbidden` | устройство отозвано или не владеет ресурсом |
| `404` | `not-found` | вопроса/устройства нет |
| `409` | `conflict` | повтор с другим телом, вопрос уже отвечен |
| `410` | `expired` | вопрос истёк по TTL |
| `413` | `payload-too-large` | тело больше лимита (вопрос/конверт) |
| `426` | `unsupported-version` | несовпадение `X-Relay-Version` |
| `429` | `rate-limited` | лимит запросов (60/мин на устройство) |
| `500` | `internal` | сбой релея (`retryable: true`) |

Набор `error.code` **открытый**: релей может добавить код в минорной версии, клиент
обязан обработать незнакомый код как `internal` с `retryable: false` (COMPATIBILITY §2, §4).

## 6. E2E-шифрование: что видит сервер

Ключи известны только плагину и устройству. В e2e-режиме сервер видит **только**:

- конверт: `enc`, `nonce` (12 байт), `keyId`, `alg`, `plainSize`;
- метаданные вопроса: `id`, `shortId`, `workspace`, `taskId`, `role`,
  `createdAt`, `expiresAt`, `optionCount`, `multiSelect`, `allowFreeText`;
- метаданные ответа: `questionId`, `answeredAt`, `idempotencyKey`;
- транспортные данные: `deviceToken` (идентификация устройства), IP, тайминги,
  размеры.

Сервер **не видит**: тело вопроса (`body`), заголовок (`title`), пояснение
(`detail`), подписи вариантов (`options[].label`), идентификаторы выбранных
вариантов и свободный текст ответа (`selected`, `custom`). Это гарантируется не
соглашением, а схемой: в e2e-режиме открытые поля **отсутствуют** (`not` в
`Question`/`AnswerRequest`), а `body`+`options`/`selected`+`enc` одновременно
невалидны.

`answeredBy` на проводе нет вообще: устройство определяется токеном, а не полем
ответа; в открытом режиме выбранные варианты передаются как `id`, чтобы подписи не
утекали в журналы релея.

Ограничения конверта: `enc` ≤ 64 КиБ (после base64), `nonce` строго 12 байт,
`plainSize` ≤ 48 КиБ; при превышении — `413 payload-too-large`. Смена `keyId` —
ротация ключа на устройстве; сервер хранит только `keyId`.

## 7. TTL

- Вопрос живёт `expiresAt` (по умолчанию 30 минут); после — `410 expired`, сообщение
  в мессенджере снимается плагином.
- `pairCode` живёт 10 минут, одноразовый; повторное использование — `404 not-found`.
- Хранилище: вопросы — `expiresAt + 24 ч`, ответы — 7 суток, устройства — до `DELETE`.
- `GET /v1/questions?since=` отдаёт только неистёкшие; истечение приходит событием
  `question.expired` в `GET /v1/events`.

## 8. Лимиты

- Размер тела запроса ≤ 96 КиБ; `enc` ≤ 64 КиБ.
- 60 запросов/мин на устройство, 10 одновременно открытых WebSocket.
- `GET /v1/questions` — `limit` 1..100 (по умолчанию 50), `since` — RFC 3339.

## 9. Примеры

В [`examples/`](examples) — валидные и невалидные пары «запрос/ответ»:

- `device-create.request.json`, `device-create.response.json`
- `pair.request.json`, `pair.response.json`
- `question.publish.request.json` (открытый вопрос), `question.encrypted.json` (e2e)
- `questions.list.response.json`
- `answer.request.json` (open), `answer.encrypted.request.json` (e2e), `answer.response.json`
- `event.message.json`, `health.response.json`, `error.response.json`
- `invalid/answer-extra-field.json`, `invalid/wrong-version.json`,
  `invalid/broken-enc.json`, `invalid/question-unknown-field.json`

Каждый пример валидируется схемой в тесте; невалидные обязаны **не** проходить.
