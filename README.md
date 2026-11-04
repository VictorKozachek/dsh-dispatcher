# dsh-dispatcher

[![CI](https://github.com/VictorKozachek/dsh-dispatcher/actions/workflows/ci.yml/badge.svg)](https://github.com/VictorKozachek/dsh-dispatcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/plugin%20tests-666%2F666-brightgreen.svg)](#тесты)

Удалённое управление вопросами агента в DSH: вопрос из `ask_user_question` уходит
в мессенджер (Telegram, затем MAX), а ответ возвращается в ту же сессию — с
маркировкой проекта, задачи и роли. Не форк и не патч ядра: плагин встаёт в
штатный waterfall `user-questions/request`.

> **English** — Remote control for [DeepSeek Harness](https://github.com/deepseek-ai)
> (DSH) agent questions: an agent that blocks on `ask_user_question` gets its
> question delivered to Telegram / MAX / a self-hosted Rust relay, and the answer
> (button or text) is returned into the very same session. No core patches — the
> plugin registers an answerer on the standard `user-questions/request`
> waterfall. It also covers tool **approvals** (`approval/request`): allow-once /
> reject / leave-to-GUI, with fail-closed timeout policy. Bundled: a Rust relay
> with end-to-end encrypted payloads, Android and iOS clients, and a kanban
> workflow for orchestrator / worker / reviewer / verifier sessions.
> Quick start: `bin/install-remote.sh --dry-run`, then `/remote connect`.

Зачем: агент, дойдя до развилки, блокируется до ответа человека. Если человек не
за клавиатурой, работа стоит. С плагином вопрос приходит на телефон, а ответ
кнопкой или текстом возвращается в сессию — ноутбук может быть закрыт.

## Из чего состоит

| Часть | Что это | Где |
|---|---|---|
| **Плагин `dsh-remote`** | host-половина (перехват вопросов, transport, `/remote`, устойчивость, панель) и клиентский таб «Удалённое управление» | [`dsh-remote/`](dsh-remote/README.md) |
| **Плагин `dsh-kanban`** | доска агентских задач в правом сайдбаре; читает `.kanban/tasks/*.md`, умеет асайн из `backlog` | внешний проект (`~/projects/dsh-kanban`), в профиле DSH |
| **Доска задач** | `.kanban/tasks/*.md`: статусы, владельцы, спеки, заметки ревью | [`.kanban/`](.kanban) |
| **Протокол ролей** | как несколько агентов работают параллельно и не пересекаются | [`AGENTS.md`](AGENTS.md) |
| **Установщик и диагностика** | `bin/install-remote.sh`, `/remote doctor`, панель | [`bin/`](bin), [`dsh-remote/README.md`](dsh-remote/README.md) |
| **Релей (Rust)** | свой сервер вместо мессенджера: WS + long-poll, TTL, привязка устройств; e2e-шифрование тела вопроса | [`relay/`](relay) |
| **Клиенты** | Android (Kotlin/Compose) и iOS (SwiftUI) — привязка, вопросы, ответы, оффлайн-очередь | [`apps/`](apps) |
| **Подтверждения** | удалённые `approval/request`: разрешить один раз / отклонить / оставить GUI, аудит, политика | [`docs/approvals.md`](docs/approvals.md) |
| **Эксплуатация** | `/remote doctor --json`, `/remote stats`, миграции состояния, ротация журналов, RUNBOOK | [`docs/RUNBOOK.md`](docs/RUNBOOK.md) |

Состояние и секреты живут **вне** репозитория: `~/.dsh/remote-control/`
(`state.json`, `log.jsonl`), токены — только через `ctx.credentials`.

## Быстрый старт

```bash
bin/install-remote.sh --dry-run   # план установки, ничего не меняет
bin/install-remote.sh             # поставить плагин в профиль web
# перезапустить профиль: dsh web (или закрыть/открыть приложение)
```

В сессии DSH:

```
/remote connect     # транспорт → токен @BotFather → код из сессии отправить боту → режим
/remote on          # включить для текущего проекта (--all — для всех)
/remote test        # проверить, что сообщение доходит
/remote doctor      # диагностика: токен, getMe, поллеры, канал, состояние
```

Пошаговая инструкция для человека (бот → подключение → вопрос, FAQ, безопасность):
[`docs/user-guide.md`](docs/user-guide.md).

## Документация

- [`docs/CONCEPT.md`](docs/CONCEPT.md) — концепция системы и границы первой очереди;
- [`.kanban/specs/001.md`](.kanban/specs/001.md) — спека первой очереди;
- [`AGENTS.md`](AGENTS.md) — протокол работы агентов, роли, жизненный цикл задачи;
- [`docs/user-guide.md`](docs/user-guide.md) — инструкция пользователя;
- [`dsh-remote/README.md`](dsh-remote/README.md) — плагин: установка, панель, `/remote`;
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — эксплуатация: инциденты, диагностика, SLO;
- [`docs/approvals.md`](docs/approvals.md) — удалённые подтверждения и политика;
- [`docs/relay/PROTOCOL.md`](docs/relay/PROTOCOL.md) — контракт плагин↔релей;
- [`docs/relay/CRYPTO.md`](docs/relay/CRYPTO.md) — e2e-шифрование и тест-векторы;
- [`docs/research/`](docs/research) — разбор хуков DSH и Bot API мессенджеров;
- [`.kanban/specs/`](.kanban/specs) — пять спек, по которым проект собран.

## Структура репозитория

```
dsh-remote/          плагин DSH (host + клиентский бандл, тесты `node --test`)
.kanban/             доска: tasks/, specs/, board.json
bin/                 скрипты: установщик, доска, задачи, тесты
docs/                концепция, руководство пользователя, research/
worktrees/<id>/      рабочие деревья задач (ветка task/<id>)
AGENTS.md            протокол ролей и карточек
KANBAN.md            шпаргалка по доске
```

## Тесты

```bash
node --test dsh-remote/test   # 666 тестов плагина (node:test, без сети)
./bin/test.sh                 # скрипты + тесты набора

cd relay && cargo test        # релей: 7 unit + 18 интеграционных
cd apps/ios && swift test     # iOS-клиент: 19 тестов
cd apps/android && ./gradlew test
cd docs/relay/impl/kotlin && ./gradlew test   # крипто-векторы (Kotlin)
cd docs/relay/impl/swift && swift test        # крипто-векторы (Swift)
```

GitHub Actions гоняет то же самое на каждый push в `main`
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): плагин и скрипты,
релей, оба Swift-пакета, крипто-векторы Kotlin и юнит-тесты Android.

Пуш в remote — шаг человека; агенты и скрипты набора не пушат и не сливают
ветки в `main` (это делает оркестратор через `bin/task-commit.sh`).

## Безопасность

Токены ботов и ключи устройств живут **вне репозитория**: `ctx.credentials`
(ссылка на переменную окружения или `~/.dsh/.credentials.yaml`), состояние — в
`~/.dsh/remote-control/` с правами `600`. Удалённые подтверждения по умолчанию
**не** дают `allowed-once` по таймауту (fail closed), опасные инструменты
(`bash`, `git push`, удаление файлов) подтверждаются только в GUI. Тела вопросов
проходят через `redact`, а релей при e2e-шифровании видит только конверт.

## Лицензия

[MIT](LICENSE) © 2026 Victor Kozachek.
