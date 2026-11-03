# dsh-remote

Плагин DSH: удалённое управление вопросами агента — вопрос из
`ask_user_question` уходит в мессенджер (Telegram, затем MAX), а ответ
возвращается в ту же сессию результатом инструмента, с маркировкой рабочего
каталога, задачи и роли. Не форк и не патч ядра: плагин встаёт в штатный
waterfall `user-questions/request`.

Сейчас здесь только каркас (задача 001): пакет поднимается в профиле, читает
`config` и держит реестр фич (`lib/features.js`). Концепция —
[docs/CONCEPT.md](../docs/CONCEPT.md), спека — `.kanban/specs/001.md`.

## Как включается и где состояние

`dsh plugin --profile <профиль> add <путь>/dsh-remote`: пакет объявляет
`dsh.bundle.patch`, в профиле появляется ряд `ui-remote` с `name: 'dsh-remote'`
(см. `cordis.patch.yml`) — руками профиль не правится, а включение режима живёт
в состоянии: `/remote on|off`.

`~/.dsh/remote-control/state.json` (атомарно, chmod 600) и `log.jsonl` без
секретов; токены мессенджеров — только через `ctx.credentials`, в git их нет.

Поставить в профиль: `bin/install-remote.sh --dry-run` (план), затем
`bin/install-remote.sh` (профиль `web` или `--profile desktop`). Скрипт
идемпотентен и отказывается ставить пакет, если в профиле остался ручной ряд
`ui-remote` — иначе плагин смонтируется дважды.

Диагностика: `/remote doctor` — список пунктов `ok/warn/fail` с подсказками
(токен и его источник, `getMe`, конфликт поллеров по lock, последняя ошибка
канала, состояние и права `state.json`, версия плагина).

Тесты: `node --test dsh-remote/test`; на Node ≥ 22 надёжнее
`node --test dsh-remote/test/*.spec.js`.
