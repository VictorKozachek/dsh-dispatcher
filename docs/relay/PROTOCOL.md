# Протокол релея DSH (v1)

Контракт между плагином `dsh-remote` и **своим** релеем: плагин публикует вопрос,
релей держит его до ответа человека, устройство (телефон) забирает вопрос и
возвращает ответ. Релей **не знает** содержимого вопроса при e2e-шифровании — видит
только конверт и метаданные (см. §6).

Статус: черновик 1.0.0 (ноябрь 2026). Спека: `.kanban/specs/003.md`.
Машиночитаемая схема: [`schema.json`](schema.json) (JSON Schema 2020-12, подмножество).
Правила совместимости: [`COMPATIBILITY.md`](COMPATIBILITY.md).
Примеры: [`examples/`](examples) (валидируются тестом `dsh-remote/test/relay.spec.js`).

## 1. Сущности

| Сущность | Поля (обязательные — **жирным**) | Смысл |
|---|---|---|
| **Device** | **deviceId**, **platform** (`ios`/`android`/`web`), **createdAt**; `pushToken?`, `label?` | Устройство человека, зарегистрированное на релее. `deviceId` — uuid, выдаёт релей; `pushToken` — для пушей, не секрет. |
| **Pairing** | **pairCode** (6 цифр), **deviceId**, **expiresAt**, **confirmed** (bool); `confirmedAt?` | Привязка устройства: плагин показывает код, человек вводит его на устройстве. Код живёт 10 минут и одноразовый. |
| **Question** | **id** (uuid), **shortId** (8 hex), **body**, **options** (`[{id,label}]`), **createdAt**, **expiresAt**; `workspace?`, `taskId?`, `role?`, `title?`, `detail?`, `multiSelect?`, `allowFreeText?`, `enc?` | Вопрос агента. `body`/`title`/`detail` при e2e-шифровании кладутся в `enc`, а в открытом виде не передаются. |
| **Answer** | **questionId**, **selected** (`string[]`), **answeredBy**, **answeredAt**, **idempotencyKey**; `custom?` | Ответ человека. `idempotencyKey` — uuid запроса; повтор с тем же ключом не создаёт второй ответ. |
| **Event** | **type**, **at**; `questionId?`, `payload?` | Событие потока: `question.created`, `question.answered`, `question.expired`, `pairing.confirmed`, `device.revoked`, `heartbeat`. |
| **EncEnvelope** | **enc**, **nonce**, **keyId**, **alg**, **plainSize** | Конверт e2e: `enc` — base64(ciphertext), `nonce` — base64(12 байт), `keyId` — id ключа, `alg` — `xchacha20poly1305` или `aes256gcm`, `plainSize` — длина открытого текста (для лимитов). Сервер не имеет ключа. |
| **Error** | **error.code**, **error.message**; `error.retryable?`, `error.details?` | Ошибка. Коды — §5. |

## 2. Версия

- Версия в пути: **`/v1/...`**. Ломающие изменения — только `/v2` (старый живёт ≥90 дней после объявления, см. COMPATIBILITY).
- Каждый запрос несёт заголовок **`X-Relay-Version: 1`** (целое). Несовпадение мажорной версии — `426 Upgrade Required` с `error.code = "unsupported-version"` и списком поддерживаемых версий в `error.details.supported`.
- Ответы содержат заголовок `X-Relay-Version` текущей версии.

## 3. Эндпоинты

Все тела — `application/json; charset=utf-8`. Аутентификация — `Authorization: Bearer <deviceToken>` (кроме `POST /v1/devices` и `POST /v1/pair`), `deviceToken` выдаётся при подтверждении привязки.

| Метод и путь | Назначение | Успех |
|---|---|---|
| `POST /v1/devices` | зарегистрировать устройство | `201` + Device |
| `DELETE /v1/devices/{id}` | отозвать устройство (токен сразу недействителен) | `204` |
| `POST /v1/pair` | начать привязку: устройство отправляет `pairCode`, релей помечает `pairing.confirmed = true` | `200` + `{deviceToken, device}` |
| `GET /v1/questions?since=<rfc3339>&limit=<n>` | вопросы, созданные/изменённые после `since` (курсор пагинации — `nextSince` в ответе) | `200` + `{questions, nextSince}` |
| `POST /v1/answers` | ответ человека; идемпотентно по `idempotencyKey` | `201` + Answer; повтор — `200` + тот же Answer |
| `GET /v1/events` | поток событий: WebSocket upgrade (заголовки `Upgrade: websocket`); без upgrade — `426` | WS; текстовые кадры — Event |
| `GET /v1/health` | живость релея | `200` + `{ok, version, at}` |
| `POST /v1/heartbeat` | устройство сообщает, что живо (интервал 30 с) | `204` |

**Heartbeat/ping:** в WebSocket — ping-кадр каждые 25 с; если pong не пришёл за 10 с,
соединение закрывается кодом `1001`, клиент переподключается с экспоненциальной
паузой (1 с → 30 с, jitter).

**Публикация вопроса плагином:** релей получает вопрос от плагина по тому же
`POST /v1/questions` (с `Authorization: Bearer <agentToken>`), ответ отдаёт
`GET /v1/answers?questionId=`; это симметрично «человеческой» стороне и упрощает
схему (см. схему: один ресурс — два владельца).

## 4. Идемпотентность и ретраи

- `POST /v1/answers` идемпотентен по `idempotencyKey` (uuid): первый запрос — `201`,
  повтор с тем же телом — `200` и тот же `Answer`; повтор с **другим** телом и тем же
  ключом — `409 conflict`.
- `POST /v1/devices` идемпотентен по `(platform, pushToken)`: повтор возвращает
  существующее устройство (`200` вместо `201`).
- Повторять можно только `5xx`, `429` и сетевые ошибки; `4xx` (кроме `429`) — нет.
- Пауза между повторами: 1 с, 2 с, 4 с, 8 с, 16 с (максимум 5 попыток), с jitter.
- `429` содержит `Retry-After` (секунды); клиент уважает его.

## 5. Ошибки

Тело ошибки — всегда `{"error": {"code": "...", "message": "...", "retryable": bool, "details"?: {}}}`.

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

## 6. E2E-шифрование: что видит сервер

Ключи известны только плагину и устройству. Сервер видит **только**:

- `enc` (base64-шифртекст), `nonce` (base64, 12 байт), `keyId`, `alg`, `plainSize`;
- метаданные: `id`, `shortId`, `createdAt`, `expiresAt`, `workspace`, `taskId`,
  `role`, количества вариантов (`options.length`), флаг `multiSelect`;
- размеры и тайминги (не содержимое).

Сервер **не видит**: тело вопроса, заголовок, варианты, свободный текст ответа,
`answeredBy`. Поэтому в схеме при наличии `enc` поля `body`/`title`/`detail`
**не передаются** (одно из двух: открытый текст или конверт).

Ограничения конверта: `enc` ≤ 64 КиБ (после base64), `nonce` строго 12 байт,
`plainSize` ≤ 48 КиБ; при превышении — `413 payload-too-large`. Смена `keyId` —
ротация ключа на устройстве; сервер хранит только `keyId` и не различает ключи по
содержимому.

## 7. TTL

- Вопрос живёт `expiresAt` (по умолчанию 30 минут) и после этого отвечать нельзя —
  `410 expired`; сообщение в мессенджере к этому времени снимается плагином.
- `pairCode` живёт 10 минут, одноразовый; повторное использование — `404 not-found`.
- Хранилище релея: вопросы хранятся `expiresAt + 24 ч` (для аттестации поздних
  ответов и метрик), затем удаляются; ответы — 7 суток; устройства — до `DELETE`.
- `GET /v1/questions?since=` отдаёт только неистёкшие; истёкшие приходят событием
  `question.expired` в `GET /v1/events`.

## 8. Лимиты

- Размер тела запроса ≤ 96 КиБ; `enc` ≤ 64 КиБ (base64).
- 60 запросов/мин на устройство, 10 одновременно открытых WebSocket.
- `GET /v1/questions` — `limit` от 1 до 100 (по умолчанию 50), `since` — RFC 3339.

## 9. Примеры

В [`examples/`](examples) лежат валидные и невалидные пары «запрос/ответ»:

- `device-create.request.json`, `device-create.response.json`
- `pair.request.json`, `pair.response.json`
- `questions.list.response.json`
- `question.encrypted.json` (вопрос с e2e-конвертом)
- `answer.request.json`, `answer.response.json`
- `event.message.json`
- `invalid/answer-extra-field.json`, `invalid/wrong-version.json`,
  `invalid/broken-enc.json`, `invalid/question-unknown-field.json`

Каждый пример валидируется схемой в тесте; невалидные обязаны **не** проходить.
