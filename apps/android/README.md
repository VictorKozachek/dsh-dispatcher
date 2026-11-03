# Android-клиент DSH Remote

MVP Android-приложения для ответа на вопросы агента с телефона. Приложение ходит
**только в релей** — с DSH и сессией агента напрямую не разговаривает:
транспорт описан в [`docs/relay/PROTOCOL.md`](../../docs/relay/PROTOCOL.md) (v1),
спека очереди — `.kanban/specs/003.md`, задача доски — `019`.

## Что умеет

- **Привязка**: адрес релея + одноразовый `pairCode` из плагина (6 цифр, живёт
  10 минут). `deviceToken` сохраняется в Android Keystore (AES-GCM), не в открытом
  виде — ни в `SharedPreferences`, ни в git.
- **Открытые вопросы**: воркспейс, задача, роль, дедлайн, число неотправленных
  ответов, состояние WebSocket.
- **Ответ**: варианты кнопками (одиночный/множественный выбор по `multiSelect`),
  свободный текст при `allowFreeText`.
- **Оффлайн-очередь**: ответ сначала пишется на диск, потом уходит в сеть; при
  отсутствии сети `WorkManager` досылает его по появлению соединения. Повтор
  идемпотентен по `idempotencyKey`, поэтому ответ не задваивается.
- **Поток событий**: WebSocket `GET /v1/events` (`question.created`,
  `question.answered`, `question.expired`), переподключение 1 с → 30 с с jitter,
  heartbeat раз в 30 секунд.
- **«Закрытые»**: история ответов устройства — отправленные, в очереди, отклонённые.
- **Уведомление о новых вопросах** из периодической фоновой проверки (FCM не
  подключён — см. ограничения).

## Сборка и запуск

Нужны JDK 17+ (проверено на JDK 21) и Android SDK с платформой 36.

```bash
cd apps/android
./gradlew :app:testDebugUnitTest   # JVM-тесты (транспорт, репозиторий, ViewModel)
./gradlew :app:assembleDebug       # APK: app/build/outputs/apk/debug/app-debug.apk
```

Установка и запуск:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n dev.dsh.remote.debug/dev.dsh.remote.ui.MainActivity
```

SDK ищется через `ANDROID_HOME` (`ANDROID_SDK_ROOT`) или `local.properties`
(`sdk.dir=…`). `local.properties` в `.gitignore`: у каждого свой путь к SDK.

В Gradle-параметрах проекта: `compileSdk = 36`, `minSdk = 26`, `targetSdk = 36`,
`buildToolsVersion = 35.0.0`. Сборка проверена на AGP 8.13.0 / Gradle 8.14.3.

Если сборка идёт в песочнице, где `~/.android` недоступен на запись (так было в
сессии задачи), Android tools можно увести в рабочее дерево:
`ANDROID_USER_HOME=$PWD/.gradle/android-user` — тогда debug-keystore создаётся
локально и APK собирается без прав на домашний каталог.

## Как пользоваться

1. В плагине запросить код привязки (`POST /v1/pairing` делает плагин) — человек
   видит 6 цифр и называет их приложению.
2. В приложении: адрес релея (например `https://relay.example.com`) и код →
   «Привязать». Приложение регистрирует устройство (`POST /v1/devices`) и
   подтверждает привязку (`POST /v1/pair`).
3. Открытые вопросы приходят потоком и сразу видны в списке; ответ — кнопкой или
   текстом. Ответ без сети не теряется: он в очереди, а рядом виден счётчик.

## Структура

| Пакет | Что там |
|---|---|
| `domain/` | модели провода (`Question`, `AnswerRequest`, `RelayEvent`), `QuestionsRepository`, `BackoffPolicy`, интерфейсы `SettingsStore`/`AnswerStore` |
| `transport/` | `HttpRelayTransport` (заголовки, коды, ретраи), `RelayWebSocketClient`, `RelayException`, `RelayJson` |
| `storage/` | `FileAnswerOutbox` (оффлайн-очередь на диске), `EncryptedSettingsStore` + `KeystoreSecretStore`, `AndroidDeviceKeyProvider` |
| `sync/`, `work/` | интерфейс планировщика, `AnswerFlushWorker`, `PeriodicCheckWorker` |
| `ui/` | экраны Compose (`PairingScreen`, `QuestionsScreen`, `QuestionScreen`, `ClosedScreen`) и ViewModel'и |

Зависимости собираются вручную в `AppContainer` — DI-фреймворк для трёх экранов
дороже пользы.

## Соответствие протоколу

| Требование (`docs/relay/PROTOCOL.md`) | Где в коде |
|---|---|
| `X-Relay-Version: 1` в каждом запросе (§2) | `HttpRelayTransport.executeOnce` |
| `Authorization: Bearer <deviceToken>` везде, кроме `POST /v1/devices` и `POST /v1/pair` (§3) | `HttpRelayTransport` |
| `POST /v1/devices` — строгое тело, идемпотентно по `(platform, publicKey)` (§4) | `registerDevice`, `DeviceCreateRequest` |
| `POST /v1/pair` — одноразовый код, автоматического повтора нет | `pair()` с `idempotent = false` |
| `GET /v1/questions?since=&sinceId=&limit=&wait=` (§3) | `listQuestions`, курсор в `QuestionsRepository.refresh` |
| `POST /v1/answers` идемпотентно по `idempotencyKey`; повтор — тот же ключ (§4) | `OutboxEntry.idempotencyKey`, `QuestionsRepository.submit` |
| Повтор только `5xx`, `429`, сеть; `4xx` — нет; `Retry-After` уважается (§4) | `RelayException.retryable`, `RetryPolicy`, `HttpRelayTransport.call` |
| WS `GET /v1/events`, ping 25 с, реконнект 1→30 с с jitter (§3) | `RelayWebSocketClient`, `defaultWebSocketClient` |
| `POST /v1/heartbeat` раз в 30 с (§3) | `QuestionsViewModel.startHeartbeat` |
| Незнакомый `type` события / `error.code` — игнорировать (COMPATIBILITY §4) | `QuestionsViewModel.handleEvent`, `RelayJson.ignoreUnknownKeys` |
| `selected` — id вариантов, а не подписи (§1) | `QuestionScreen` передаёт `option.id` |

## Ограничения MVP (осознанные)

- **FCM не подключён**: нужен аккаунт Firebase, а приложение живёт без него. В
  фоне WebSocket не держится — новые вопросы появляются при открытии приложения и
  периодической проверкой раз в 15 минут (`PeriodicCheckWorker`; `WorkManager` в
  Doze может задержать запуск). Уведомления показываются, только если человек дал
  разрешение `POST_NOTIFICATIONS`; без разрешения приложение работает как обычно.
- **E2E**: ключ устройства генерируется (X25519, где платформа не умеет — EC
  P-256) и его публичная половина уходит в `POST /v1/devices`, приватная лежит в
  Keystore-хранилище. Расшифровки тела вопроса нет — это задача **021**; вопрос с
  конвертом `enc` показывается только метаданными, ответ на него недоступен.
- **Релизная подпись** не настроена: секретов в git нет, `assembleRelease` даёт
  неподписанный APK. Подпись — шаг выпуска, вне репозитория.
- **Сервер** (`relay/`) приложение не меняет и не требует: контракт v1 один для
  всех.
- iOS-клиент — задача **020**, каталог `apps/ios` этой задачей не трогается.

## Тесты

JVM-юнит-тесты (`./gradlew :app:testDebugUnitTest`), без эмулятора:

| Файл | Что проверяет |
|---|---|
| `core/BackoffPolicyTest` | 1→2→4→8→16 с, потолок 30 с, границы jitter |
| `core/DeadlineTest` | формат дедлайна и «истёк» |
| `core/DeviceKeysTest` | формат `base64:` публичного ключа, уникальность, RFC 3339 |
| `transport/HttpRelayTransportTest` | версия/авторизация в заголовках, строгие тела, `since/sinceId/limit/wait`, повтор 5xx с тем же ключом, отсутствие повтора на 409/401, `Retry-After`, маппинг ошибок |
| `transport/RelayWebSocketClientTest` | событие из кадра, переподключение после обрыва, отсутствие привязки, битый кадр |
| `transport/RelayJsonTest` | аддитивные ответы, строгие запросы, `selected: []`, неизвестные код/тип |
| `storage/FileAnswerOutboxTest` | очередь переживает рестарт, уникальность ключей, битый файл |
| `domain/QuestionsRepositoryTest` | оффлайн-ответ уходит один раз, 409/400 не повторяются, 5xx остаётся в очереди, курсор и fullSync, фильтрация |
| `ui/QuestionsViewModelTest` | старт, события WS, ответ онлайн/оффлайн, планировщик |
| `ui/PairingViewModelTest` | валидация, сохранение токена, ошибки сети/кода |

Инструментальных (эмуляторных) тестов нет: UI проверяется сборкой
`assembleDebug`, а логика — юнит-тестами.

Прогон в сессии задачи: **63 теста, 0 падений** (`:app:testDebugUnitTest`),
`assembleDebug` собирает `app/build/outputs/apk/debug/app-debug.apk` (~13 МБ).
