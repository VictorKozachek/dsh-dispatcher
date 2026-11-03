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
curl -s localhost:8080/v1/health
# {"ok":true,"version":"0.1.0","at":"...","devices":0}
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

Все — под `/v1`; заголовок `X-Relay-Version: 1` обязателен (иначе `426`).

| Метод и путь | Кто | Что делает |
|---|---|---|
| `GET /v1/health` | без авторизации | `{ok, version, at, devices}` |
| `POST /v1/devices` | без авторизации | регистрация устройства (`platform`, `publicKey`), идемпотентно по паре |
| `DELETE /v1/devices/{id}` | агент или само устройство | отзыв: токен перестаёт работать, WS-сессии закрываются |
| `POST /v1/pairing-codes` | агент | создать одноразовый `pairCode` (TTL 10 минут) и показать человеку |
| `POST /v1/pair` | без авторизации | подтвердить код → `deviceToken` |
| `POST /v1/questions` | агент | опубликовать вопрос (открытый или e2e) |
| `GET /v1/questions?since=&limit=&wait=` | устройство | вопросы; `wait` — long-poll вместо WS |
| `POST /v1/answers` | устройство | ответ; идемпотентно по `idempotencyKey` |
| `GET /v1/answers?questionId=&wait=` | агент | ответ; `wait` — long-poll |
| `GET /v1/events` | устройство или агент | WebSocket: события `question.created/answered/expired`, `pairing.confirmed`, `device.revoked`, `heartbeat` |
| `POST /v1/heartbeat` | устройство | отметка «живо» (30 с) |

`POST /v1/pairing-codes` — единственное дополнение к документу 016: плагину нужен
способ получить код, который он покажет человеку. Эндпоинт аддитивный (новый путь
под `/v1`), совместимость не ломает.

## Очередь, TTL и повторы

- Вопросы хранятся в SQLite и отдаются устройству, пока не истекли и не отвечены;
  `GET /v1/questions?wait=N` и `GET /v1/answers?wait=N` дают long-poll вместо
  WebSocket (оффлайн-устройство догоняет по `since`).
- Фоновая задача раз в секунду помечает истёкшие вопросы и публикует
  `question.expired` (ровно один раз на вопрос).
- Вопросы удаляются через `expiresAt + 24 ч`, коды привязки — через сутки после
  истечения, ответы живут 7 суток.
- Повторы доставки — на клиенте (плагин/устройство) по правилам протокола:
  только `5xx`/`429`/сеть, backoff 1→16 с, `Retry-After`; сервер идемпотентен по
  `idempotencyKey` и `(platform, publicKey)`.

## E2E и приватность

Сервер не хранит ключей: в e2e-режиме он видит только `enc`, `nonce`, `keyId`,
`alg`, `plainSize` и метаданные (id, shortId, workspace, taskId, role, время,
`optionCount`). Валидация запрещает открытые поля (`body`/`title`/`detail`/`options`
и `selected`/`custom`) рядом с `enc` — такой запрос получает `400 bad-request`.
Битый конверт и неизвестная версия дают `400`/`426`, сервер при этом не падает.

**Логи** — структурный JSON без тел вопросов/ответов и без токенов: только
`question`/`short_id`/`device`/`reason`/`error`. Это проверяется тестом
`logs_do_not_contain_question_bodies_or_tokens`.

## Тесты

```bash
cargo test
```

- интеграционные (`tests/integration.rs`): сервер на случайном порту, сценарий
  «привязка → вопрос → ответ → TTL» (событие `question.expired` по WebSocket),
  идемпотентность ответа, отзыв устройства, битый конверт, неизвестная версия,
  логи без тел и токенов;
- юнит-тесты хранилища (`src/db.rs`): идемпотентная регистрация, одноразовый и
  истекающий `pairCode`, идемпотентные ответы, TTL-выборка, маскирование токена.

Тулчейн: Rust 1.82+ (проверено на `cargo 1.98`). Если `cargo` в окружении нет,
тесты остаются в репозитории и запускаются `cargo test` на машине с тулчейном.
