# Транспорты мессенджеров для диспетчера вопросов (Telegram Bot API и MAX Bot API)

Техническая справка на **ноябрь 2026**. Задача-сценарий: локальный агент на ноутбуке
пользователя формирует вопрос, бот пересылает его человеку в мессенджер, человек
отвечает кнопкой или текстом, ответ возвращается агенту.

Все утверждения ниже — из официальной документации платформ ([core.telegram.org](https://core.telegram.org/bots/api),
[dev.max.ru](https://dev.max.ru/docs-api)); ссылки собраны в разделе
[«Источники»](#источники). Места, где документация молчит или где я опираюсь на
практику, помечены явно: **⚠ практика** / **⚠ не документировано**.

---

## 0. Краткое резюме

| Вопрос | Telegram | MAX |
|---|---|---|
| Что нужно от человека | токен от @BotFather (30 секунд, без регистрации юрлица) | верифицированный профиль **юрлица / ИП / самозанятого — резидента РФ** + модерация до 48 ч |
| Приём обновлений без публичного адреса | **да**, `getUpdates` (long polling) — штатный режим | формально есть `GET /updates`, но документация прямо называет его **не-production** |
| Приём обновлений «правильно» | webhook: HTTPS, порты 443/80/88/8443, самоподписанный сертификат можно загрузить | webhook: **только 443**, **только доверенный CA** (в т.ч. Минцифры), самоподписанные запрещены с 25.05.2026 |
| Лимит текста | 4096 символов | 4000 символов |
| Кнопки + колбэки | inline keyboard + `callback_query` + `answerCallbackQuery` | `inline_keyboard` + `message_callback` + `POST /answers` (умеет и текст ответа, и правку сообщения) |
| Правка сообщения после ответа | `editMessageText` / `editMessageReplyMarkup` | `PUT /messages`; сообщения **с кнопками правятся всегда**, остальные — 7 суток |
| Троттлинг | ~1 msg/сек в чат, 20 msg/мин в группе, ~30 msg/сек суммарно; 429 + `retry_after` | **2 msg/сек в чат**, 30 rps на весь API; код 429 |
| Риск доступности в РФ | высокий: по сообщениям СМИ с апреля 2026 доступ ограничивается | низкий (национальный мессенджер, продвигается государством) |

**Вывод:** первым делать **Telegram** (нулевая инфраструктура, работает за NAT,
бот заводится за минуту), вторым — **MAX** (нужен либо публичный HTTPS на 443 через
туннель, либо жизнь на «не-production» long polling). Оба прячутся за одним
интерфейсом `QuestionTransport`, см. [§7](#7-абстракция-транспорта).

---

## 1. Telegram Bot API

Продукт: [@BotFather](https://t.me/botfather) + HTTP API. База:
`https://api.telegram.org/bot<token>/METHOD_NAME`, только HTTPS, методы
регистронезависимы, кодировка UTF-8. Параметры можно передавать в query string,
`application/x-www-form-urlencoded`, `application/json` или `multipart/form-data`
(последнее — для файлов).

Ответ всегда JSON с булевым `ok`; при ошибке — `error_code`, `description` и
опциональный `parameters` типа
[ResponseParameters](https://core.telegram.org/bots/api/types/responseparameters)
(там живёт `retry_after`).

### 1.1. Создание бота и что нужно от пользователя

| Что нужно | Где взять | Комментарий |
|---|---|---|
| **Токен** | @BotFather → `/newbot` → имя + username (обязан заканчиваться на `bot`) | формат `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`; при compromised — `/token` перевыпускает |
| **chat_id владельца** | написать боту `/start`, затем `getUpdates` → `message.chat.id`; либо `https://api.telegram.org/bot<token>/getMe` для проверки токена | у приватного чата `chat_id` — это `user_id` человека (положительное число), у групп — отрицательное |
| **user_id владельца** | `message.from.id` / `callback_query.from.id` | именно его кладём в allowlist, а не `chat_id` |
| Права бота | для личного чата — никаких; бот не может писать первым, пока человек не нажал `/start` | в groups по умолчанию включён *privacy mode*: бот видит только команды и реплаи к нему |

Полезно сразу после создания: `/setjoingroups` → `Disable` (бот не будет
добавляться в группы — для сценария «один владелец» это лишняя поверхность
атаки), `/setdescription`, `/setcommands`.

Проверка токена:

```bash
curl -s "https://api.telegram.org/bot${TG_TOKEN}/getMe"
```

### 1.2. Получение сообщений: long polling vs webhook

Два режима **взаимно исключительны** — пока установлен webhook, `getUpdates`
возвращает ошибку. Обновления хранятся на сервере **не дольше 24 часов**
независимо от режима.

#### getUpdates (long polling)

Параметры ([док](https://core.telegram.org/bots/api#getupdates)):

| Параметр | Тип | Смысл |
|---|---|---|
| `offset` | Integer | id первого ожидаемого обновления = `update_id` последнего обработанного **+ 1**. Подтверждает всё, что меньше |
| `limit` | Integer | 1–100, по умолчанию 100 |
| `timeout` | Integer | таймаут long polling в секундах, по умолчанию 0 (обычный short polling). Документация не задаёт верхнюю границу; **⚠ практика:** 25–50 с — рабочий диапазон, 0 допустим только для тестов |
| `allowed_updates` | Array of String | какие типы апдейтов получать, напр. `["message","callback_query"]` |

```bash
curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/getUpdates" \
  -H 'Content-Type: application/json' \
  -d '{"offset": 812345678, "timeout": 50, "allowed_updates": ["message","callback_query"]}'
```

Ключевые правила: `offset` пересчитывать после **каждого** ответа (иначе дубли);
`update_id` монотонно растёт и уникален — это готовый ключ дедупликации; при
простое ≥ недели следующий id выбирается случайно (важно: не полагаться на
непрерывность последовательности).

#### setWebhook

Требования ([док](https://core.telegram.org/bots/api#setwebhook)): HTTPS-URL,
порты **443, 80, 88 или 8443**, CN сертификата должен точно совпадать с доменом,
редиректы не поддерживаются, wildcard-сертификаты могут не работать. Свой
самоподписанный сертификат можно загрузить параметром `certificate` (именно
`InputFile`, строкой не работает). На не-2XX ответ Telegram повторяет доставку
«разумное число раз».

```bash
curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{
        "url": "https://agent.example.com/tg/hook-7f3a91",
        "secret_token": "s3cr3t_path_token_42",
        "max_connections": 10,
        "allowed_updates": ["message","callback_query"],
        "drop_pending_updates": true
      }'
```

`secret_token` (1–256 символов `A-Za-z0-9_-`) приезжает в заголовке
`X-Telegram-Bot-Api-Secret-Token` — единственный штатный способ убедиться, что
запрос от Telegram. Дополнительно полезен «секретный путь» в самом URL.
`max_connections` — 1–100 (по умолчанию 40); для ноутбука ставить 1–5.
Диагностика — `getWebhookInfo` (`pending_update_count`, `last_error_message`).

#### Что выбрать на ноутбуке за NAT

**Long polling.** Публичный адрес, сертификат, проброс порта не нужны: исходящее
соединение устанавливает сам ноутбук. Плюсы: нет точки входа снаружи, нет
простоя при смене сети, «оффлайн» = просто перестали получать обновления (они
подождут до 24 часов). Минусы: задержка до одного цикла поллинга, постоянное
соединение. Webhook для этого сценария — только если есть туннель
(cloudflared/ngrok) или VPS; тогда обязательны 443 и валидный сертификат.

Отдельная лазейка: **локальный Bot API server** (`telegram-bot-api`) умеет
webhook по HTTP, на любом адресе и порту, и `max_webhook_connections` до 100000 —
актуально, если захочется принимать апдейты в локальной сети без TLS.

### 1.3. Отправка сообщений

`sendMessage` ([док](https://core.telegram.org/bots/api/methods/sendmessage)):
`text` — **1–4096 символов после парсинга entities**; `parse_mode` —
`MarkdownV2` | `HTML` | устаревший `Markdown`; альтернатива — `entities`
(JSON-список), если не хотим экранировать; `reply_parameters` — reply-to;
`reply_markup` — inline/reply клавиатура; `disable_notification`,
`protect_content`, `link_preview_options`.

**Форматирование.** MarkdownV2 требует экранировать символы `_ * [ ] ( ) ~ > # + - = | { } . !`
и обратную кавычку (внутри `code`/`pre` — дополнительно ещё и обратный слэш). HTML поддерживает узкое подмножество:
`<b> <i> <u> <s> <span class="tg-spoiler"> <a href> <code> <pre> <blockquote>`
(+ `tg-emoji`, `tg-time`), а `<`, `>` и `&` вне тегов обязаны быть
`&lt; &gt; &amp;`. Для агентских текстов (код, диффы, пути) **HTML проще**:
меньше экранирования и предсказуемее.

**Кнопки-варианты и колбэки.** `InlineKeyboardMarkup` → нажатие приходит как
`callback_query` (с `id`, `data`, `from`, `message.message_id`). На каждый колбэк
бот **обязан** ответить `answerCallbackQuery` — иначе у пользователя крутится
«часики», а BotFather шлёт алерты «Too few answers to callback queries».

`callback_data` у кнопки — **1–64 байта**; у кнопки есть `style`
(`danger` | `success` | `primary`) — удобно для пар «удалить / оставить».

```bash
# вопрос с кнопками
curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d '{
        "chat_id": 123456789,
        "parse_mode": "HTML",
        "text": "<b>Вопрос</b> · ws:<code>dsh-dispatcher</code> · task <code>007</code>\n\nУдалить ветку <code>task/007</code> после слияния?",
        "reply_parameters": {"message_id": 4242, "allow_sending_without_reply": true},
        "reply_markup": {
          "inline_keyboard": [
            [{"text": "Да, удалить", "callback_data": "ans:7f3a91:yes"}],
            [{"text": "Оставить",   "callback_data": "ans:7f3a91:no"}],
            [{"text": "Другой ответ…", "callback_data": "ans:7f3a91:free"}]
          ]
        }
      }'
```

```bash
# ответ на нажатие (тост) + правка сообщения после ответа
curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery" \
  -H 'Content-Type: application/json' \
  -d '{"callback_query_id": "4382901234", "text": "Принято: Да, удалить", "show_alert": false}'

curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/editMessageText" \
  -H 'Content-Type: application/json' \
  -d '{
        "chat_id": 123456789,
        "message_id": 4243,
        "parse_mode": "HTML",
        "text": "✅ <b>Отвечено</b> · task <code>007</code>\nВопрос: удалить ветку?\nОтвет: <b>Да, удалить</b> (17:42)",
        "reply_markup": {"inline_keyboard": []}
      }'
```

Правятся только сообщения **без** `reply_markup` или с inline-клавиатурой;
`reply_markup` в `editMessageText` заменяет клавиатуру целиком — пустой
`inline_keyboard: []` убирает кнопки (это и есть «закрыть вопрос»). Есть также
`editMessageReplyMarkup` (только клавиатура) и `deleteMessage`.

**Тестовый контур.** Отдельный бот + префикс `/test`:
`https://api.telegram.org/bot<token>/test/METHOD_NAME`. Flood-лимиты там **не**
подняты и могут быть строже.

### 1.4. Rate limits и 429

Из [FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this):

- в один чат — **не больше 1 сообщения в секунду** (короткие всплески допустимы);
- в группу — **не больше 20 сообщений в минуту**;
- суммарно «широковещательно» — **~30 сообщений в секунду** (Paid Broadcasts поднимают до 1000/сек за 0.1 Stars за сообщение сверх нормы);
- при превышении — HTTP **429**, в теле `parameters.retry_after` (секунды).

Поведение: ждать ровно `retry_after` + джиттер, ретраить с экспоненциальной
задержкой, ограничить число попыток (3–5), не ретраить 400/403 (это ошибки
запроса или прав), 5xx ретраить. Своя исходящая очередь на чат с интервалом
≥ 1 c — дешевле, чем ловить 429.

### 1.5. Секреты и ограничение «один чат»

- Токен — только в переменных окружения или в keychain; файл `chmod 600`; **не**
  в git, не в логах, не в тексте ошибок. Токен = полный контроль над ботом.
- Ограничение «один чат» штатного флага не имеет: бот доступен всем, кто знает
  username. Реализуется **на своей стороне**: allowlist по `from.id` для
  сообщений и колбэков, allowlist по `chat_id` для чата доставки, игнор всего
  остального (можно отвечать «этот бот приватный»).
- Дополнительно: `/setjoingroups` → Disable; при webhook — `secret_token` +
  секретный путь в URL; для отладки — отдельный бот.

---

## 2. MAX (российский мессенджер, dev.max.ru)

Платформа ботов MAX (ранее VK/Mail.ru). **База: `https://platform-api2.max.ru`**
— документация прямо просит использовать `platform-api2`, а не
`platform-api` (и добавлять сертификат Минцифры в доверенные).
Авторизация — **заголовок** `Authorization: <access_token>`; передача токена
через query-параметры **больше не поддерживается**.

Коды ответов: `200` успех, `400` невалидный запрос, `401` аутентификация,
`404` не найдено, `405` метод не разрешён, `429` превышено количество запросов,
`503` сервис недоступен.

### 2.1. Как создать бота и что нужно от пользователя

**Требование платформы (жёсткое):** подключение к платформе MAX для партнёров и
её сервисам доступно **юрлицам, ИП и самозанятым — резидентам РФ**. Физлицо без
одного из этих статусов бота завести не может. Нужен верифицированный профиль.

| Что нужно | Где взять |
|---|---|
| Верифицированный профиль организации / ИП / самозанятого | [business.max.ru/self](https://business.max.ru/self) либо мини-приложение [«MAX для бизнеса»](https://max.ru/business_bot?startapp) |
| **Токен бота** | business.max.ru/self → **Чат-боты** → выбрать бота → **⋮** → **Настройки** → копировать; либо в мини-приложении / у бота «MAX для бизнеса» командой **«Получить токен»** |
| **chat_id** или **user_id** получателя | см. [§2.5](#25-где-взять-chat_id-и-user_id) |
| Модерация | бот создаётся в статусе «на модерации», проверка **до 48 часов по рабочим дням**; до публикации токен и настройки недоступны |

Квоты: **5 ботов** на профиль организации/ИП, **2 бота** на самозанятого.
Никнейм генерируется автоматически (`idИНН_bot` для ИП/юрлиц, `se(orgid)_bot` для
самозанятых) и **не меняется**; публичная ссылка — `max.ru/idИНН_bot`. Логотип
500×500, ≤5 МБ, jpg/png; название 1–59 символов; описание ≤200 символов.

Проверка токена:

```bash
curl -s "https://platform-api2.max.ru/me" -H "Authorization: ${MAX_TOKEN}"
```

### 2.2. Получение обновлений: long polling vs webhook

Документация MAX занимает однозначную позицию: **в production — только webhook**,
long polling — для разработки и тестирования. Одновременно оба режима
использовать нельзя: при активной подписке long polling не работает.

#### Long polling: `GET /updates`

| Параметр | Значения | Смысл |
|---|---|---|
| `limit` | 1–1000, по умолчанию 100 | максимум обновлений в ответе |
| `timeout` | 0–90, по умолчанию 30 | таймаут длинного опроса, секунды |
| `marker` | int64 / null | указатель на следующее ожидаемое обновление; всё, что до него, считается прочитанным. **Если `marker` не передан — вернётся только последнее обновление** |
| `types` | string[] | фильтр типов событий |

```bash
curl -s "https://platform-api2.max.ru/updates?timeout=30&limit=100&marker=${MARKER}" \
  -H "Authorization: ${MAX_TOKEN}"
```

Ограничения режима (формулировки документации): «ограничено по скорости и сроку
хранения событий — этот способ **не подходит для production-окружения**».
**⚠ не документировано:** конкретные значения скорости и срока хранения событий
не опубликованы — планировать на них нельзя.

#### Webhook: `POST /subscriptions`

```bash
curl -s -X POST "https://platform-api2.max.ru/subscriptions" \
  -H "Authorization: ${MAX_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
        "url": "https://agent.example.com/max/hook-7f3a91",
        "update_types": ["message_created", "message_callback", "bot_started"],
        "secret": "s3cr3t_path_token_42"
      }'
```

Требования к endpoint (жёстче, чем у Telegram):

- **только HTTPS и только порт 443** (порт в URL не указывается; недоступен — события не доставляются);
- сертификат от **доверенного CA** или сертификат **Минцифры**; **самоподписанные запрещены**, CN/SAN должен совпадать с доменом, нужна полная цепочка;
- **с 25 мая 2026** поддержка HTTP и самоподписанных сертификатов прекращена;
- endpoint обязан вернуть **HTTP 200 в течение 30 секунд**; любой другой код или таймаут = ошибка доставки;
- ретраи: до **10 попыток** с ростом интервала ×2.5 (60 c → 150 c → 375 c → …); если за **8 часов** успешного ответа не было — бот **автоматически отписывается** от webhook;
- `secret` (5–256 символов `[a-zA-Z0-9_-]`) приезжает в заголовке **`X-Max-Bot-Api-Secret`** — сверять обязательно.

**Что это значит для ноутбука за NAT:** «правильный» путь MAX требует публичного
домена, валидного сертификата и порта 443 — то есть туннеля (cloudflared, ngrok,
VPS с reverse-proxy). Без туннеля остаётся `GET /updates`, который платформа
сама называет непроизводственным: события могут теряться/задерживаться, а при
перезапуске ноутбука часть истории недоступна. Для диспетчера вопросов это
терпимо (вопрос имеет TTL и дублируется в локальном состоянии), но требует
осторожности: `marker` хранить на диск, а не в памяти.

### 2.3. Отправка сообщений, кнопки, колбэки

`POST /messages?user_id=<id>` или `?chat_id=<id>`. Тело
([док](https://dev.max.ru/docs-api/methods/POST/messages)):

| Поле | Ограничение |
|---|---|
| `text` | **≤ 4000 символов** |
| `format` | `"markdown"` \| `"html"` |
| `attachments` | массив; **всего ≤ 12**; `inline_keyboard` — не более одного |
| `link` | `{type: "reply"\|"forward", mid: "<id>"}` — reply-привязка к сообщению |
| `notify` | bool, по умолчанию `true` (push) |
| `disable_link_preview` | bool |

```bash
curl -s -X POST "https://platform-api2.max.ru/messages?user_id=${MAX_USER_ID}" \
  -H "Authorization: ${MAX_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
        "text": "**Вопрос** · ws: dsh-dispatcher · task 007\n\nУдалить ветку task/007 после слияния?",
        "format": "markdown",
        "link": {"type": "reply", "mid": "mid.0000000001"},
        "attachments": [{
          "type": "inline_keyboard",
          "payload": {"buttons": [
            [{"type": "callback", "text": "Да, удалить", "payload": "ans:7f3a91:yes"}],
            [{"type": "callback", "text": "Оставить",    "payload": "ans:7f3a91:no"}]
          ]}
        }]
      }'
```

Ответ содержит `message.body.mid` — это id сообщения, нужный для правки и
reply-привязки; его надо сохранить рядом с `questionId`.

**Клавиатура** ([док](https://dev.max.ru/docs-api/use-cases/sending-messages/keyboard)):
до **210 кнопок**, до **30 рядов**, до **7 кнопок в ряду** (до 3 — для типов
`link`, `open_app`, `request_geo_location`, `request_contact`). Типы кнопок:
`callback`, `link`, `message` (отправляет заранее заданный текст),
`request_contact`, `request_geo_location`, `open_app`, `clipboard`.
Кнопки **не пересылаются** вместе с сообщением в другой чат.

**Колбэк.** Нажатие на `callback` даёт событие `message_callback`; идентификатор
кнопки — в `updates[i].callback.callback_id`, полезная нагрузка — в
`callback.payload` (см. [объект Update](https://dev.max.ru/docs-api/objects/Update)).
Ответ — `POST /answers?callback_id=<id>`:

```bash
curl -s -X POST "https://platform-api2.max.ru/answers?callback_id=${CB_ID}" \
  -H "Authorization: ${MAX_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
        "message": {
          "text": "✅ Отвечено · task 007\nВопрос: удалить ветку?\nОтвет: **Да, удалить** (17:42)",
          "format": "markdown",
          "attachments": [{"type": "inline_keyboard", "payload": {"buttons": []}}]
        }
      }'
```

Это сильная сторона MAX: `POST /answers` **одним запросом** и подтверждает
нажатие, и заменяет текст/кнопки сообщения (у Telegram — два вызова:
`answerCallbackQuery` + `editMessageText`).

**Правка сообщения** — `PUT /messages?message_id=<mid>`, тело как у отправки.
Ограничения ([док](https://dev.max.ru/docs-api/methods/PUT/messages)):
в диалогах сообщения **с `inline_keyboard` правятся независимо от срока давности**,
остальные — только если отправлены **менее 7 суток назад**; в группах и каналах —
без ограничения по возрасту; **не более 2 правок в секунду** в один чат.

**Форматирование** ([док](https://dev.max.ru/docs-api/use-cases/sending-messages/text-formatting)):
Markdown — `*em*`/`_em_`, `**strong**`/`__strong__`, `~~strike~~`, `++underline++`,
`` `code` ``, `[link](url)`, `^^mark^^`, `# заголовок`, `> цитата`. HTML —
`<i>/<em> <b>/<strong> <del>/<s> <ins>/<u> <pre>/<code> <a href> <mark> <h1..h6>
<blockquote>`. Упоминание пользователя — ссылкой `max://user/<user_id>`.
В комментариях гиперссылки и упоминания не поддерживаются.

### 2.4. Лимиты, 429, ретраи

- **2 сообщения в секунду** в один диалог/чат/канал (превышение → очередь/задержка);
  столько же для `POST /answers` и `PUT /messages`;
- **30 rps** суммарно на `platform-api2.max.ru`;
- код **429** «превышено количество запросов»; **⚠ не документировано:** MAX не
  описывает ни заголовок `Retry-After`, ни тело с `retry_after`, поэтому
  безопасная стратегия — собственный троттлинг (2 rps на чат, ≤30 rps на бота) и
  экспоненциальный backoff с джиттером на 429/503;
- `503` — сервис недоступен: ретраить; `401` — токен, не ретраить; `400`/`405` — ошибка запроса, не ретраить.

### 2.5. Где взять chat_id и user_id

Готового «списка чатов» API **не даёт**: `GET /chats` перестал поддерживаться
с июня 2026. Порядок получения ([док](https://dev.max.ru/docs-api/use-cases/getting-chat-id)):

1. Оформить подписку (`POST /subscriptions`) или `GET /updates` на события `bot_added` / `bot_started`;
2. получить `chat_id` в объекте `Update` (или `user_id` из `update.user.user_id` для диалога);
3. сохранить у себя, обрабатывая дубли (одно событие может прийти повторно);
4. удалять `chat_id` по событиям `bot_removed` / `dialog_removed`.

Практический «пейринг» для диспетчера: человек жмёт `/start` (событие
`bot_started`) → бот отвечает одноразовым кодом → код вводится в конфиг на
ноутбуке вместе с `user_id`. Так `user_id` не приходится искать руками.

Типы событий `Update`: `bot_added`, `bot_started`, `bot_stopped`, `bot_removed`,
`message_created`, `message_callback`, `message_edited`, `message_removed`,
`dialog_cleared/muted/unmuted/removed`, `chat_title_changed`, `comment_*`,
`user_added/removed`, `bot_admin_permissions_changed` (только webhook).

### 2.6. Секреты и ограничение «один чат»

- Токен — из настроек бота, **отзывается** платформой за нарушение правил; хранить
  так же, как токен Telegram (env/keychain, `chmod 600`, без логов).
- Бот в MAX добавляется человеком в диалог/чат; «белый список» — на своей стороне
  по `user_id`/`chat_id` из `Update`. Отдельно в карточке бота есть настройки
  приватности/кнопки запуска — их стоит держать в закрытом виде.
- Для webhook обязателен `secret` → `X-Max-Bot-Api-Secret`; плюс секретный путь в URL.

---

## 3. Сравнительная таблица

| Критерий | Telegram Bot API | MAX Bot API |
|---|---|---|
| Порог входа | @BotFather, `/newbot`, 1 минута; физлицу доступно | профиль юрлица/ИП/самозанятого-резидента РФ, верификация, модерация ≤48 ч |
| База / авторизация | `https://api.telegram.org/bot<token>/…` | `https://platform-api2.max.ru`, `Authorization: <token>` |
| Long polling | есть, штатный, `getUpdates` (`timeout`, `offset`, `limit` 1–100) | есть, `GET /updates` (`timeout` 0–90, `marker`, `limit` 1–1000), но **официально не для production** |
| Webhook | HTTPS, порты 443/80/88/8443, самоподписанный можно загрузить | **только 443**, только доверенный CA/Минцифры, самоподписанные запрещены; 200 за 30 c; 10 ретраев; отписка через 8 ч |
| Работа за NAT без туннеля | **да** (polling) | **только** через polling «для разработки» |
| Лимит текста | 4096 | 4000 |
| Разметка | MarkdownV2 / HTML / entities | markdown / html |
| Кнопки | inline keyboard, без документированного лимита на число | inline_keyboard: 210 кнопок / 30 рядов / 7 в ряду |
| Колбэк | `callback_query` + `answerCallbackQuery` (текст ≤200) | `message_callback` + `POST /answers` (может сразу заменить сообщение) |
| Правка после ответа | `editMessageText`, `editMessageReplyMarkup`; только inline-клавиатуры | `PUT /messages`; с кнопками — без ограничения возраста, без кнопок — 7 суток |
| Reply-привязка | `reply_parameters.message_id` (+ `quote`) | `link: {type:"reply", mid}` |
| Троттлинг | ~1 msg/c в чат, 20/мин в группу, ~30/сек суммарно | 2 msg/c в чат, 30 rps всего |
| 429 | `parameters.retry_after` | код 429, поле не документировано |
| Дедупликация | `update_id` (монотонный) | **нет** глобального id → ключ из `callback_id` / `mid` / `timestamp` |
| Хранение апдейтов | до 24 ч | «ограничено по сроку хранения» (числа не опубликованы) |
| Риск доступности в РФ | **высокий**: по сообщениям СМИ с апреля 2026 доступ к Telegram ограничивается, мобильный интернет в ряде регионов отключался | **низкий**: национальный мессенджер, продвигается и предустанавливается |
| Зрелость экосистемы | огромная (библиотеки, примеры, Local Bot API Server, test env) | небольшая, но есть официальные JS/Go клиенты и OpenAPI-схема |

**Про доступность — аккуратно.** Официального решения о блокировке Telegram в РФ
нет, но независимые измерения и пресса фиксируют систематические ограничения с
весны 2026, а MAX продвигается как «национальный» мессенджер
([VRT NWS, 01.04.2026](https://www.vrt.be/vrtnws/nl/2026/04/01/rusland-verbod-op-telegram-vladimir-poetin-kremlin-geert-groot-k/)).
Для диспетчера это значит: **Telegram удобнее технически, MAX надёжнее по
доступности внутри РФ** — и именно поэтому транспорт должен быть сменным.

---

## 4. Рекомендация (обоснование)

### 4.1. Порядок реализации

**Первым — Telegram.** Причины: (1) единственный транспорт, который работает на
ноутбуке за NAT **без единой строчки инфраструктуры** — `getUpdates` не требует
публичного адреса, сертификата и домена; (2) бот заводится за минуту и не требует
юрлица; (3) полный набор нужных примитивов — inline-кнопки, колбэки, правка
сообщения, reply-to — есть и документирован до деталей; (4) поведение при 429
описано машиночитаемо (`retry_after`), что позволяет написать предсказуемый
retry-слой; (5) есть тестовый контур и Local Bot API Server.

**Вторым — MAX.** Он закрывает главный риск Telegram (доступность в РФ), но
платит за это: обязательный профиль ИП/юрлица/самозанятого, модерация до 48 ч,
webhook только на 443 с доверенным сертификатом (для ноутбука — туннель или VPS),
а long polling официально не предназначен для production. Ставить его первым
означало бы упереться в организационные барьеры раньше, чем появится рабочий
продукт.

**Практическая схема:** Telegram — основной канал; MAX — второй канал,
включается флагом конфигурации, когда есть туннель (или как «best effort» на
`GET /updates`). Один и тот же вопрос может уходить в оба канала, ответ
принимается **первый пришедший**, второй помечается как «отвечено в другом
канале» — тогда недоступность любого из мессенджеров не блокирует агента.

### 4.2. Какие абстракции нужны, чтобы второй транспорт не потребовал переделки

Границы, которые различаются у платформ и потому должны быть спрятаны:

1. **Транспортный id сообщения** — `message_id` (TG) vs `mid` (MAX).
2. **Колбэк** — «ответить на нажатие» и «заменить сообщение» — один вызов в MAX, два в Telegram.
3. **Дедупликация** — `update_id` в TG, композитный ключ в MAX.
4. **Доставка обновлений** — polling vs webhook, с разными требованиями к хосту.
5. **Пагинация/курсор** — `offset` vs `marker` (и `marker` надо персистить).
6. **Лимиты** — длина текста (4096/4000), троттлинг (1/2 msg/c), размер клавиатуры.
7. **Разметка** — MarkdownV2 с агрессивным экранированием vs markdown MAX; проще
   всего **не отдавать разметку наружу**: транспорт принимает структуру
   (заголовок/тело/подпись) и сам её рендерит.

Минимальный общий интерфейс (TypeScript; смысл не зависит от языка):

```ts
export type TransportId = "telegram" | "max";

export interface QuestionOption { id: string; label: string; }

export interface OutgoingQuestion {
  questionId: string;        // наш UUID; кодируется в callback_data/payload
  workspace: string;         // «воркспейс» для маркировки в тексте
  sessionId: string;
  agentName: string;
  title: string;             // короткий заголовок вопроса
  body: string;              // произвольный текст (без разметки)
  options: QuestionOption[]; // пусто => только свободный ввод
  allowFreeText: boolean;
  expiresAt: Date;           // TTL вопроса
  threadRef?: string;        // reply-to: id предыдущего сообщения, если есть
}

export interface IncomingAnswer {
  questionId: string;
  transport: TransportId;
  optionId?: string;         // если нажали кнопку
  text?: string;             // если ответили текстом/reply
  answeredBy: string;        // внешний user id (для allowlist)
  receivedAt: Date;
  transportMessageId: string;
  late: boolean;             // пришёл после expiresAt
}

export interface DeliveryTarget { chatId: string; }

export interface QuestionTransport {
  readonly id: TransportId;
  readonly caps: {
    inlineButtons: boolean;
    editAfterAnswer: boolean;
    longPolling: boolean;
    webhook: boolean;
    maxTextLength: number;
  };
  start(): Promise<void>;                 // поднимает polling или HTTP-endpoint
  stop(): Promise<void>;
  sendQuestion(q: OutgoingQuestion, to: DeliveryTarget):
    Promise<{ transportMessageId: string }>;
  closeQuestion(args: {
    transportMessageId: string;
    to: DeliveryTarget;
    summary: string;                      // «Отвечено: Да, удалить (17:42)»
    by?: { userId: string; label: string };
  }): Promise<void>;
  onAnswer(handler: (a: IncomingAnswer) => Promise<void>): void;
  healthCheck(): Promise<boolean>;
}
```

Правила, которые делают второй транспорт дешёвым:

- прикладной код **никогда** не видит `message_id`/`mid` — только `transportMessageId` из ответа транспорта;
- прикладной код **никогда** не собирает текст с разметкой — транспорт рендерит её сам;
- `callback_data` у Telegram — **1–64 байта** (документировано), поэтому кодировать только `q:<short-id>:<opt>`, полный id хранить у себя;
- все лимиты (длина, троттлинг, размер клавиатуры) — свойства `caps`, а не константы в бизнес-логике;
- дедупликация и `marker`/`offset` — забота транспорта, наружу отдаётся уже «очищенный» поток.

---

## 5. Детали реализации диспетчера

### 5.1. Идемпотентность и дедупликация апдейтов

- **Telegram:** ключ — `update_id`; хранить `last_update_id` на диск (атомарно, до
  обработки), `offset = last + 1`. Дополнительно — LRU обработанных
  `(chat_id, message_id)` для колбэков (повторное нажатие кнопки возможно).
- **MAX:** глобального `update_id` нет. Ключ — `sha256(chat_id, update_type,
  callback.callback_id | message.body.mid, timestamp)`. Плюс идемпотентность на
  уровне домена: `questionId` в состоянии переходит `open → answered` **один раз**
  (атомарный `UPDATE … WHERE status='open'`); повторный ответ логируется и
  игнорируется.
- **Исходящие:** перед повторной отправкой вопроса проверять
  `questionId → transportMessageId`; при таймауте запроса — сначала `PUT`/`edit`
  по сохранённому id, и только потом новая отправка. Максимум один «дубль»
  сообщения при падении процесса — приемлемая цена без распределённых локи.

### 5.2. Таймаут ответа (человек не ответил 30 минут)

Рекомендуемая политика — **не молчать и не блокировать агента**:

1. `expires_at = created_at + TTL` (30 мин по умолчанию, настраивается per-question).
2. За 5 минут до истечения — «мягкое» напоминание: правка сообщения
   (`editMessageText` / `PUT /messages`) с пометкой «⏳ осталось 5 минут» — без
   нового push-уведомления (`notify: false` в MAX, отсутствие `disable_notification` в TG не спасает от звука, поэтому лучше именно правка).
3. По истечении — закрыть вопрос: убрать кнопки (`inline_keyboard: []`), дописать
   «⌛ вопрос снят по таймауту», вернуть агенту результат `{status: "expired",
   answer: null}`. Агент обязан иметь **default-действие** (например, «ничего не
   удалять», «продолжить без подтверждения») — иначе система встанет.
4. Поздний ответ **принимать**, но помечать `late: true`: человек мог ответить на
   уже закрытый вопрос; бизнес-логика решает, применить ли его (для «удалить
   ветку» — применить безопасно, для необратимых действий — переспросить).
5. Sweeper — периодическая задача (раз в минуту), а не `sleep` в обработчике.

### 5.3. Несколько вопросов из разных сессий в один чат

Один чат — один поток сообщений, поэтому каждый вопрос обязан быть
самоидентифицируемым:

- **Маркировка в тексте:** первая строка — `▸ ws: dsh-dispatcher · task 007 · agent: worker` (для TG — `<code>`, для MAX — `` ` `` или просто текст), затем пустая строка и тело вопроса.
- **Машиночитаемая привязка:** `callback_data` / `payload` = `q:<shortId>:<optionId>`, где `shortId` — первые 6–8 символов `questionId`; полное соответствие живёт в локальной таблице. Так нажатие кнопки однозначно определяет вопрос **без** разбора текста.
- **Reply-привязка для свободного ввода:** вопрос отправляется как reply к сообщению-«якорю» сессии (`reply_parameters.message_id` в TG, `link:{type:"reply",mid}` в MAX); ответ человека в виде reply распознаётся по `reply_to_message.message_id` / `link.mid`. Если reply нет — принимаем обычный текст, но **только** если открыт ровно один вопрос с `allowFreeText`; иначе просим ответить кнопкой или реплаем.
- **Порядок:** вопросы в чате нумеруются (`#3`), а в тексте ставится дедлайн — человек видит, какой из них горит.
- **Закрытие:** после ответа сообщение правится (кнопки убираются, дописывается «✅ Отвечено: …»), чтобы в чате не оставалось «живых» кнопок от старых вопросов.

### 5.4. Безопасность: кто может отвечать

- **Allowlist по user id**, а не по чату: TG — `from.id` в `message`/`callback_query`;
  MAX — `update.user.user_id`. Всё, что не совпало, — игнорировать (и логировать).
  `chat_id` проверять тоже: сообщение из чужого чата не должно приниматься, даже
  если user id совпал (пересланное сообщение).
- **Пейринг:** человек нажимает `/start`, бот выдаёт одноразовый код (TTL 10 мин),
  код вводится в конфиг на ноутбуке → в allowlist попадает конкретный `user_id`.
  Ручной поиск id через API остаётся как резерв.
- **Секреты:** токены — только env/OS-keychain; файл конфигурации `chmod 600`;
  маскировать в логах (`bot<id>:…` → `bot<id>:***`); для MAX помнить, что токен
  отзывается платформой.
- **Webhook (если используется):** TG — `secret_token` + секретный путь; MAX —
  `secret` → `X-Max-Bot-Api-Secret` + секретный путь. Отвечать 200 быстро, а
  обработку делать асинхронно (у MAX жёсткий лимит 30 c, иначе ретраи и отписка).
- **Никаких секретов в тексте вопроса:** тело вопроса уходит на серверы
  мессенджера — вычищать токены/пути до отправки.

### 5.5. Ограничение времени жизни вопроса

- TTL хранится в записи вопроса (`expires_at`), дублируется в тексте сообщения
  («ответить до 17:42») — человек видит срок, не открывая ничего.
- Просроченные вопросы не удаляются из БД сразу: статус `expired` нужен для
  аудита и для приёма «поздних» ответов; чистить через N дней.
- Кнопки просроченного вопроса обязательно снимать (правка сообщения) — иначе
  человек нажмёт кнопку и получит «вопрос уже закрыт», что выглядит как баг.

### 5.6. Чек-лист «что сломается первым»

| Симптом | Причина | Лечение |
|---|---|---|
| TG: `409 Conflict: terminated by other getUpdates request` | два процесса/инстанса поллят один токен | один поллер на токен, лок-файл |
| TG: дубли ответов | не пересчитывается `offset` | `offset = update_id + 1` сразу после обработки |
| TG: «часики» на кнопке | не вызван `answerCallbackQuery` | вызывать **до** бизнес-логики |
| MAX: события не приходят | webhook активен, а поллинг тоже запущен / endpoint не отдаёт 200 за 30 c | один режим; быстрый 200 |
| MAX: бот «отписался» | 8 часов без успешной доставки | health-check подписки `GET /subscriptions`, пере-подписка |
| MAX: «слишком часто» | >2 msg/c в чат | своя очередь на чат |
| Оба: «вопрос потерялся» | TTL истёк, а агент ждал вечно | default-действие + статус `expired` |

---

## 6. Итоговые цифры (шпаргалка)

| | Telegram | MAX |
|---|---|---|
| Текст | 4096 | 4000 |
| Кнопок | не документировано | 210 (30×7) |
| `callback_data` | 1–64 байта (документировано) | `payload` — строкой |
| Сообщений/сек в чат | 1 | 2 |
| Всего запросов/сек | ~30 msg/сек | 30 rps |
| Апдейты живут | 24 ч | не опубликовано |
| `timeout` поллинга | без верхней границы в доке (**⚠ 25–50 c**) | 0–90 c (по умолчанию 30) |
| Правка сообщения | без ограничения возраста (inline-клавиатуры) | с кнопками — всегда; без — 7 суток |

---

## Источники

### Telegram Bot API (официальное)

- [Bot API — общее описание, авторизация, локальный сервер](https://core.telegram.org/bots/api)
- [getUpdates](https://core.telegram.org/bots/api#getupdates) · [setWebhook](https://core.telegram.org/bots/api#setwebhook) · [deleteWebhook / getWebhookInfo](https://core.telegram.org/bots/api#getwebhookinfo)
- [Update (update_id, типы апдейтов)](https://core.telegram.org/bots/api#update)
- [sendMessage](https://core.telegram.org/bots/api/methods/sendmessage) · [answerCallbackQuery](https://core.telegram.org/bots/api/methods/answercallbackquery) · [editMessageText](https://core.telegram.org/bots/api#editmessagetext) · [editMessageReplyMarkup](https://core.telegram.org/bots/api#editmessagereplymarkup)
- [Форматирование: MarkdownV2, HTML, entities](https://core.telegram.org/bots/api#formatting-options)
- [ReplyParameters](https://core.telegram.org/bots/api#replyparameters) · [InlineKeyboardMarkup](https://core.telegram.org/bots/api#inlinekeyboardmarkup) · [InlineKeyboardButton — `callback_data` 1–64 байта, `style`](https://core.telegram.org/bots/api#inlinekeyboardbutton) · [CallbackQuery](https://core.telegram.org/bots/api#callbackquery)
- [ResponseParameters (retry_after)](https://core.telegram.org/bots/api#responseparameters)
- [Bot FAQ: лимиты рассылки, 429, webhook-требования](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)
- [Bot Features: BotFather, создание бота, токен, privacy mode, тестовый контур](https://core.telegram.org/bots/features#botfather)
- [@BotFather](https://t.me/botfather) · [telegram-bot-api (исходники локального сервера)](https://github.com/tdlib/telegram-bot-api)

### MAX Bot API (официальное)

- [Обзор API: базовый домен `platform-api2.max.ru`, авторизация, коды ответов](https://dev.max.ru/docs-api)
- [GET /updates — long polling (limit, timeout, marker, types)](https://dev.max.ru/docs-api/methods/GET/updates/)
- [POST /subscriptions — webhook: 443, TLS, 30 c, ретраи, secret](https://dev.max.ru/docs-api/methods/POST/subscriptions/)
- [Уведомления о событиях: webhook vs long polling, 30 rps](https://dev.max.ru/docs-api/use-cases/event-notifications/)
- [Объект Update и полный список типов событий](https://dev.max.ru/docs-api/objects/Update/)
- [POST /messages — отправка, лимит 4000, format, attachments, link](https://dev.max.ru/docs-api/methods/POST/messages/)
- [PUT /messages — редактирование, ограничения по сроку и частоте](https://dev.max.ru/docs-api/methods/PUT/messages/)
- [POST /answers — ответ на callback (текст и/или правка сообщения)](https://dev.max.ru/docs-api/methods/POST/answers/)
- [Клавиатура: типы кнопок, 210 кнопок / 30 рядов / 7 в ряду](https://dev.max.ru/docs-api/use-cases/sending-messages/keyboard/)
- [Форматирование текста: markdown и html](https://dev.max.ru/docs-api/use-cases/sending-messages/text-formatting/)
- [Получение chat_id и user_id](https://dev.max.ru/docs-api/use-cases/getting-chat-id/)
- [Создание и модерация чат-бота: требования к профилю, квоты, 48 ч](https://dev.max.ru/docs/chatbots/bots-create/create)
- [Платформа MAX для партнёров (профиль, токен)](https://business.max.ru/self) · [MAX для бизнеса (мини-приложение)](https://max.ru/business_bot?startapp)
- [OpenAPI-схема MAX](https://github.com/max-messenger/api-schema) · [JS-клиент](https://github.com/max-messenger/max-bot-api-client-ts) · [Go-клиент](https://github.com/max-messenger/max-bot-api-client-go)

### Контекст доступности (пресса, не документация)

- [VRT NWS, 01.04.2026: ограничения доступа к Telegram в РФ и продвижение MAX](https://www.vrt.be/vrtnws/nl/2026/04/01/rusland-verbod-op-telegram-vladimir-poetin-kremlin-geert-groot-k/)
- [Anadolu: Telegram адаптируется к российским ограничениям](https://f.aa.com.tr/en/asia-pacific/telegram-to-adapt-to-russian-restrictions-making-traffic-harder-to-detect-and-block-says-app-founder/3891872)
