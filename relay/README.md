# dsh-relay

Релей вопросов DSH: плагин `dsh-remote` публикует вопрос, телефон забирает его и
возвращает ответ. Протокол — v1 из [`docs/relay/PROTOCOL.md`](../docs/relay/PROTOCOL.md)
(задача 016). Это серверная часть (задача 017), без UI и без Docker (Docker — 022).

## Запуск одной командой

```bash
cargo run
```

По умолчанию поднимается `http://127.0.0.1:8080` и SQLite-файл `relay.db`
(схема применяется миграциями из `migrations/` при старте). Если
`RELAY_AGENT_TOKEN` не задан, сервер сгенерирует токен и напишет его подсказку в
лог (`token_hint`, только хвост) — для локальной разработки задайте свой:

```bash
RELAY_AGENT_TOKEN=dev-agent-token RELAY_BIND=127.0.0.1:8080 cargo run
```

Проверка живости:

```bash
curl -s -H 'X-Relay-Version: 1' localhost:8080/v1/health
# {"ok":true,"version":"0.1.0","at":"...","devices":0,"questions":0,"answers":0}
curl -s -H 'X-Relay-Version: 1' localhost:8080/healthz
# алиас для liveness-проб (та же структура)
```

## Переменные окружения

| Переменная | Значение по умолчанию | Смысл |
|---|---|---|
| `RELAY_BIND` | `127.0.0.1:8080` | адрес прослушивания |
| `RELAY_DATABASE_URL` | `sqlite://relay.db?mode=rwc` | SQLite (`sqlite::memory:` — тесты) |
| `RELAY_AGENT_TOKEN` | генерируется при старте | Bearer для плагина (агента) |
| `RELAY_ALLOWED_DEVICES` | пусто = все | список `deviceId` через запятую (allowlist) |
| `RELAY_QUESTION_TTL_SECONDS` | `1800` | TTL вопроса по умолчанию (для `expiresAt` из запроса) |
| `RELAY_PAIRING_TTL_SECONDS` | `600` | TTL кода привязки |
| `RELAY_LONG_POLL_MAX_SECONDS` | `25` | максимум `wait` для long-poll |

## Эндпоинты

Все — под `/v1`; заголовок `X-Relay-Version: 1` **обязателен** (016 §2): без него
`400 bad-request`, при другой версии — `426 unsupported-version` со списком
поддерживаемых. `GET /healthz` — алиас `/v1/health` для liveness-проб.

| Метод и путь | Кто | Что делает |
|---|---|---|
| `GET /v1/health` | без авторизации | `{ok, version, at, devices}` |
| `POST /v1/devices` | без авторизации | регистрация устройства (`platform`, `publicKey`), идемпотентно по паре |
| `DELETE /v1/devices/{id}` | агент или само устройство | отзыв: токен перестаёт работать, WS-сессии закрываются |
| `POST /v1/pairing` | агент | создать одноразовый `pairCode` (TTL 10 минут) и показать человеку |
| `POST /v1/pair` | без авторизации | подтвердить код → `deviceToken` |
| `POST /v1/questions` | агент | опубликовать вопрос (открытый или e2e) |
| `GET /v1/questions?since=&limit=&wait=` | устройство | вопросы; `wait` — long-poll вместо WS |
| `POST /v1/answers` | устройство | ответ; идемпотентно по `idempotencyKey` |
| `GET /v1/answers?questionId=&wait=` | агент | ответ; `wait` — long-poll |
| `GET /v1/events` | устройство или агент | WebSocket: события `question.created/answered/expired`, `pairing.confirmed`, `device.revoked`, `heartbeat` |
| `POST /v1/heartbeat` | устройство | отметка «живо» (30 с) |

### Отличия от документа 016 (аддитивные)

Всё перечисленное — новые пути/параметры под `/v1`, совместимость не ломают:

- `POST /v1/pairing` — плагину нужен способ получить код, который он покажет
  человеку; в 016 описан только `POST /v1/pair`, который код **принимает**.
- `?wait=<сек>` у `GET /v1/questions` и `GET /v1/answers` — long-poll fallback для
  устройства без WebSocket (016 требует лишь WS).
- `GET /healthz` — алиас `/v1/health` (пункт «наблюдаемость» карточки 017).
- `nextId`/`sinceId` — tie-break курсора пагинации для вопросов с одинаковым
  `createdAt` (пачка из `ask_user_question`).
- `GET /v1/health` дополнительно отдаёт счётчики `devices`/`questions`/`answers`
  (ответ аддитивный по 016, новые поля клиент игнорирует).

Строгость запросов соблюдается: неизвестные поля (включая `options[]` и `enc`)
отвергаются `400` (`additionalProperties:false`), `version` в теле обязан быть `1`,
`POST /v1/questions` принимает **только** wrapper `{"question": {...}}`
(`QuestionPublishRequest`), а `POST /v1/answers` — поля из `AnswerRequest`.

Эти дополнения внесены в контракт (карточка 023): `docs/relay/PROTOCOL.md`,
`schema.json` (`PairingCodeResponse`, путь `/healthz`, query-схемы
`QuestionQuery`/`AnswerQuery`, `nextId`) и `COMPATIBILITY.md` §2b. Сервер,
документ и тесты контракта (`node --test dsh-remote/test`) согласованы.

## Очередь, TTL и повторы

- Вопросы хранятся в SQLite и отдаются устройству, пока не истекли и не отвечены;
  `GET /v1/questions?wait=N` и `GET /v1/answers?wait=N` дают long-poll вместо
  WebSocket (оффлайн-устройство догоняет по `since`).
- Фоновая задача раз в секунду помечает истёкшие вопросы и публикует
  `question.expired` (ровно один раз на вопрос).
- Вопросы удаляются через `expiresAt + 24 ч`, коды привязки — через сутки после
  истечения, ответы живут 7 суток.
- **Повторы доставки:** серверная очередь pull-модельная — неотвеченный вопрос
  остаётся в очереди до `expiresAt` и отдаётся на каждый `GET /v1/questions`
  (в том числе по `since`-курсору и long-poll), пока на него не ответят или он не
  истечёт. Клиентские повторы — по протоколу (только `5xx`/`429`/сеть, backoff
  1→16 с, `Retry-After`); сервер идемпотентен по `idempotencyKey` и
  `(platform, publicKey)`.
- **Курсор пагинации:** составной — `nextSince` (`createdAt`) + `nextId` (id);
  запрос `?since=...&sinceId=...` продолжает `(created_at, id) > (since, sinceId)`,
  поэтому страницы не теряются и не дублируются даже при одинаковом `createdAt`.
- **Идемпотентность ответа:** тот же `idempotencyKey` + то же тело → `200`; тот же
  ключ с другим телом → `409 conflict`.
- **Привязка:** код одноразовый и подтверждается атомарным `UPDATE ... WHERE
  confirmed = 0 AND expires_at > now`, поэтому два одновременных `/pair` не могут
  оба выиграть гонку. Неизвестное/отозванное устройство проверяется **до** claim —
  неудачная попытка не сжигает код.
- **Гонки записи:** регистрация устройства и ответ идемпотентны через
  `INSERT ... ON CONFLICT`: параллельные запросы не дают `500` (повтор получает
  `200`/`409`).

## E2E и приватность

Сервер не хранит ключей: в e2e-режиме он видит только `enc`, `nonce`, `keyId`,
`alg`, `plainSize` и метаданные (id, shortId, workspace, taskId, role, время,
`optionCount`). Валидация запрещает открытые поля (`body`/`title`/`detail`/`options`
и `selected`/`custom`) рядом с `enc` — такой запрос получает `400 bad-request`.
Битый конверт и неизвестная версия дают `400`/`426`, сервер при этом не падает.

**WebSocket и видимость:** релей однопользовательский — все устройства
пользователя видят общие события вопросов/ответов; события с `payload.deviceId`
(`pairing.confirmed`, `device.revoked`) отдаются только этому устройству.
WS-подключение проходит ту же проверку allowlist (`RELAY_ALLOWED_DEVICES`), что и
HTTP-эндпоинты: устройство вне списка получает `403`.

**Логи** — структурный JSON без тел вопросов/ответов и без токенов: только
`question`/`short_id`/`device`/`reason`/`error`. Это проверяется тестом
`logs_do_not_contain_question_bodies_or_tokens`.

## Тесты

```bash
cargo test
```

- интеграционные (`tests/integration.rs`, 12 тестов): сервер на случайном порту,
  сценарий «привязка → вопрос → ответ → TTL» (событие `question.expired` по
  WebSocket), идемпотентность ответа и конфликт тела, пагинация 60 вопросов по
  50 без потерь, гонка двух `/pair`, отзыв устройства, битый конверт, отсутствие и
  несовпадение `X-Relay-Version`, неизвестные поля и сырой вопрос вместо wrapper,
  фильтр WS-событий чужого устройства, `/healthz` и счётчики, логи без тел и
  токенов;
- юнит-тесты хранилища (`src/db.rs`): идемпотентная регистрация, одноразовый и
  истекающий `pairCode`, идемпотентные ответы, TTL-выборка, маскирование токена.

Тулчейн: Rust 1.82+ (проверено на `cargo 1.98`). Если `cargo` в окружении нет,
тесты остаются в репозитории и запускаются `cargo test` на машине с тулчейном.
