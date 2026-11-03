# Self-host релея DSH

Релей (`relay/`, Rust) за Caddy с автоматическим TLS: **одна команда** поднимает
сервер, дальше — домен, сертификат, привязка устройства и вопрос из плагина.

```
Интернет ──443──▶ Caddy (TLS, Let's Encrypt) ──▶ relay:8080 (только в сети compose)
                                                   └─ SQLite в томе relay_data
```

## Что нужно

- VPS или домашний сервер с Docker 24+ и Compose v2 (поддерживает
  `env_file.required: false`), 1 ГБ RAM (релей + Caddy).
- Сборка образа: Rust 1.82+ (в Dockerfile `rust:1.82-slim`); MSRV зависимостей
  проверяется при первой сборке — при обновлении `relay/Cargo.lock` поднимите
  базовый образ.
- **Домен**, A/AAAA-запись которого указывает на сервер (например
  `relay.example.com`). Без домена Caddy не выпустит сертификат.
- Открытые порты **80 и 443** (80 нужен для ACME HTTP-01 и редиректа на HTTPS).

## Быстрый старт

```bash
git clone <этот репозиторий> dsh && cd dsh
cp deploy/.env.example deploy/.env
# отредактируйте deploy/.env: RELAY_DOMAIN и RELAY_AGENT_TOKEN
#   openssl rand -hex 32   → RELAY_AGENT_TOKEN

docker compose -f deploy/docker-compose.yml up -d --build
```

Проверка:

```bash
curl -fsS -H 'X-Relay-Version: 1' https://relay.example.com/healthz
# {"ok":true,"version":"0.1.0","at":"...","devices":0,"questions":0,"answers":0}
```

`deploy/smoke.sh` прогоняет полный сценарий (healthz → привязка → вопрос →
ответ → идемпотентный повтор):

```bash
RELAY_BASE_URL=https://relay.example.com \
RELAY_AGENT_TOKEN=$(grep '^RELAY_AGENT_TOKEN=' deploy/.env | cut -d= -f2-) \
  deploy/smoke.sh
```

## TLS

Caddy получает сертификат Let's Encrypt автоматически при первом запросе на
домен (HTTP-01; для wildcard нужен DNS-01 — не требуется для одного домена).
Сертификаты и ключи Caddy лежат в томе `caddy_data` и переживают пересоздание
контейнеров. Продление — автоматическое, за 30 дней до истечения.

Если сертификат не выпускается:

- DNS ещё не указывает на сервер (`dig +short relay.example.com`);
- порт 80 закрыт файрволом/security group;
- домен уже занят другим ACME-клиентом (см. `docker compose logs caddy`).

## Первое устройство

1. Плагин `dsh-remote` подключается к релею как **агент**:
   `/remote connect` → «Relay (свой сервер)» → URL `https://relay.example.com` →
   токен агента (`RELAY_AGENT_TOKEN`). Токен сохраняется в `ctx.credentials`, в
   состояние плагина попадает только URL.
2. Код привязки для телефона выдаёт сам агент: `POST /v1/pairing` с токеном агента
   возвращает `{pairCode, expiresAt}` (TTL 10 минут). Его показывает клиент
   (iOS/Android) или `deploy/smoke.sh`-подобный сценарий.
3. Телефон: `POST /v1/devices` (platform + publicKey) → `POST /v1/pair`
   (`pairCode` + `deviceId`) → `deviceToken`. Токен хранится **только в Keychain
   устройства**, на сервер уходит лишь его хеш.
4. Вопросы: плагин публикует `POST /v1/questions`, устройство читает
   `GET /v1/questions`, отвечает `POST /v1/answers`; события — WebSocket
   `GET /v1/events` (Caddy проксирует upgrade) или long-poll `?wait=`.

## Allowlist устройств

По умолчанию привязаться может любое устройство, знающее код. Чтобы ограничить
круг, укажите в `.env`:

```env
RELAY_ALLOWED_DEVICES=<deviceId>,<deviceId>
```

и перезапустите релей: `docker compose -f deploy/docker-compose.yml up -d`.
Пустая/закомментированная переменная означает «списка нет» (разрешены все
привязанные устройства) — релей одинаково понимает отсутствие переменной и
пустую строку, а compose передаёт её только когда она задана в `.env`
(`env_file` вместо подстановки пустой строки). `deviceId` виден в ответе
`POST /v1/devices`/`POST /v1/pair` и в логах привязки (в `GET /v1/health` только
счётчик устройств). После ограничения чужие устройства получают `403` (в том
числе на WebSocket).

## Обновление

```bash
git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

Миграции SQLite применяются релеем при старте (`relay/migrations`), том
`relay_data` при пересборке не трогается. Перед обновлением сделайте бэкап
(ниже) — миграции необратимых изменений в MVP не делают, но спокойнее.

## Бэкап

```bash
deploy/backup.sh
# deploy/backups/relay-20261103T031700Z.tar.gz (+ .sha256)
```

- Внутри: `relay.db` (консистентный снимок через `sqlite3 .backup`) и
  `manifest.json` с sha256, временем и версией релея.
- В docker-режиме снимок делается внутри контейнера (там есть `sqlite3`), затем
  копируется на хост; релей останавливать не нужно.
- Локальный режим (VPS без docker / тесты): `RELAY_DB_FILE=/path/relay.db
  deploy/backup.sh`.
- Ротация: `RETENTION_DAYS` (по умолчанию 14), старые архивы удаляются.
- Cron: `17 3 * * * cd /opt/dsh && deploy/backup.sh >> /var/log/dsh-backup.log 2>&1`.

**Что НЕ бэкапится:** приватные ключи e2e-шифрования (задача 021) — они живут
только на устройствах и в плагине; сервер хранит лишь `keyId` и конверт.
Сертификаты Caddy — отдельный том `caddy_data`, при необходимости:
`docker run --rm -v dsh-relay_caddy_data:/data -v "$PWD":/backup alpine tar czf /backup/caddy.tgz -C /data .`.

## Восстановление

```bash
deploy/restore.sh deploy/backups/relay-20261103T031700Z.tar.gz
```

Скрипт сверяет sha256 **самого архива** с хешем из `.sha256` (путь в файле
игнорируется — бэкап можно переименовать и перенести на другой сервер),
проверяет `PRAGMA integrity_check` и sha256 базы из `manifest.json`, делает
резервную копию текущей базы, кладёт восстановленную в том и ждёт `/healthz`.
Подменённый архив при «живом» `.sha256` отвергается. Локальный режим —
`RELAY_DB_FILE=...`.

В docker-режиме том называется `<project>_relay_data` (по умолчанию
`dsh-relay_relay_data`); если вы задали `COMPOSE_PROJECT_NAME` или переименовали
каталог, передайте `RELAY_VOLUME=<volume>` (посмотреть: `docker volume ls`).

Проверка «после восстановления всё живо»:

```bash
RELAY_BASE_URL=https://relay.example.com RELAY_AGENT_TOKEN=... deploy/smoke.sh
```

## Отзыв устройства

```bash
curl -fsS -X DELETE -H 'X-Relay-Version: 1' \
  -H "authorization: Bearer $RELAY_AGENT_TOKEN" \
  https://relay.example.com/v1/devices/<deviceId>
```

Токен устройства перестаёт работать сразу, его WebSocket-сессии закрываются.
В MVP-клиенте кнопки отзыва нет — отзывайте с сервера (или через плагин).

## Безопасность и секреты

- `deploy/.env` — единственное место секретов на сервере; `.gitignore` исключает
  его из git. `RELAY_AGENT_TOKEN` не переиспользуйте между серверами.
- Наружу открыт только Caddy (80/443); релей слушает 8080 только в сети compose.
- Логи релея — структурный JSON без тел вопросов/ответов и токенов; pairing-код в
  логи не пишется.
- `X-Relay-Version: 1` обязателен для всех запросов; несовпадение — `426`.

## Проверка deploy-набора без Docker

```bash
deploy/check.sh     # bash -n всех скриптов, обязательные файлы и ключи, compose config
```

`docker compose config` в `check.sh` — обязательная проверка: если compose-файл
сломан, скрипт падает (а не пишет «пропущен»). Для сборки образа из корня
репозитория лежит `.dockerignore` — в демон не уезжают `.git`, `worktrees/`,
`apps/`, `docs/`, `relay/target/` и бэкапы.

Если Docker-демона нет (как в песочнице разработки), скрипты всё равно проверяются
локальным релеем:

```bash
cd relay && cargo build --release && cd ..
RELAY_BIN=$PWD/relay/target/release/dsh-relay deploy/test-local.sh
# smoke + allowlist (пустой/непустой) + backup + переименование/подмена архива
# + restore + healthz — один прогон
```

Полный ручной путь без Docker (если `test-local.sh` не подходит):

```bash
RELAY_AGENT_TOKEN=dev-token RELAY_BIND=127.0.0.1:18080 \
RELAY_DATABASE_URL="sqlite:file:$PWD/data/relay.db?mode=rwc" \
  ./relay/target/debug/dsh-relay &            # или: cd relay && cargo run
RELAY_BASE_URL=http://127.0.0.1:18080 RELAY_AGENT_TOKEN=dev-token deploy/smoke.sh
RELAY_DB_FILE=$PWD/data/relay.db deploy/backup.sh
RELAY_DB_FILE=$PWD/data/relay.db deploy/restore.sh deploy/backups/<архив>.tar.gz
```

## Диагностика

| Симптом | Что смотреть |
|---|---|
| `healthz` не отвечает | `docker compose ps`, `docker compose logs relay` |
| TLS не выпускается | DNS, порт 80, `docker compose logs caddy` |
| Привязка `404` | код истёк (10 минут) или уже использован; выдайте новый `POST /v1/pairing` |
| `401` у плагина | неверный `RELAY_AGENT_TOKEN`; `connect` проверяет его авторизованным пробником |
| `403` у устройства | устройство отозвано или не в `RELAY_ALLOWED_DEVICES` |
| вопросы не приходят | устройство оффлайн: long-poll `?wait=25`, WS переподключается с backoff |
