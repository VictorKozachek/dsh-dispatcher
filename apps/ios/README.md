# RelayApp (iOS MVP)

Минимальный клиент релея DSH: **привязка → вопросы → ответ**, закрытые вопросы,
оффлайн-очередь ответов. Контракт — `docs/relay/PROTOCOL.md` (016 + 023), сервер —
`relay/` (017). Экраны и логика общие с Android (`apps/android`, задача 019):
расхождения фиксируются в протоколе, а не «по-своему» в клиенте.

## Требования

- Xcode 15+ (проверено на Xcode 27.2 / Swift 6.4), iOS 17+.
- SPM-пакет, без внешних зависимостей.

## Сборка и запуск

Xcode:

```bash
open apps/ios/Package.swift     # Xcode покажет пакет как проект
# выберите схему RelayApp и iOS-симулятор, Run
```

Или из терминала:

```bash
cd apps/ios
swift build                      # macOS-сборка (для быстрой проверки)
xcodebuild -scheme RelayApp -destination 'platform=iOS Simulator,name=iPhone 15' build
```

Запуск на macOS (SwiftUI-приложение кросс-платформенное, удобно для отладки):

```bash
cd apps/ios && swift run RelayApp
```

В песочнице агента SwiftPM не может писать в `~/Library` и не может применить
собственный sandbox, поэтому сборка шла так (на обычной машине флаги не нужны):

```bash
TMPDIR="$PWD/.build/tmp" CLANG_MODULE_CACHE_PATH="$PWD/.build/modulecache" \
  swift test --disable-sandbox --scratch-path .build --cache-path .build/spm-cache
```

## Тесты

```bash
cd apps/ios && swift test
```

8 юнит-тестов, сеть не нужна (фейковый `RelayAPI`, временный файл очереди,
in-memory Keychain):

- загрузка показывает только открытые вопросы;
- ответ кнопкой/текстом уходит и закрывает вопрос;
- **оффлайн-ответ переживает перезапуск** и повторяется с тем же
  `idempotencyKey` (сервер не создаёт второй ответ);
- повторный ответ до отправки заменяет первый, не меняя ключ;
- события `question.answered`/`question.expired` закрывают вопрос;
- парсинг WS-событий;
- привязка кладёт токен в Keychain, а не рядом с URL/deviceId; `unpair` чистит.

## Что внутри

| Файл | Роль |
|---|---|
| `Sources/RelayKit/Models.swift` | `RelayQuestion`, `RelayAnswer` (с `idempotencyKey`), `RelayPairing`, `RelayAPIError` |
| `Sources/RelayKit/RelayClient.swift` | HTTP (`URLSession`) + WebSocket (`URLSessionWebSocketTask`) с `Authorization` и `X-Relay-Version: 1`, переподключение с backoff 1→30 с |
| `Sources/RelayKit/QuestionsViewModel.swift` | состояние экранов, ответ через очередь, события потока |
| `Sources/RelayKit/OfflineQueue.swift` | файловая очередь ответов (`Application Support/pending-answers.json`), переживает перезапуск |
| `Sources/RelayKit/Secrets.swift` | `SecretStore`; `KeychainStore` для токена, `InMemorySecretStore` для тестов |
| `Sources/RelayKit/Pairing.swift` | `PairingService`: `POST /v1/devices` → `POST /v1/pair` → Keychain; URL/deviceId — в `UserDefaults` |
| `Sources/RelayApp/*` | SwiftUI: экран привязки, список вопросов, вопрос/ответ, закрытые, настройки |

## Поток

1. **Привязка:** человек вводит URL релея и 6-значный `pairCode`. Приложение
   регистрирует устройство (`POST /v1/devices`, публичный ключ — задел под e2e),
   меняет код на `deviceToken` (`POST /v1/pair`) и кладёт токен в Keychain.
2. **Вопросы:** `GET /v1/questions` с Bearer; открытые — в списке, закрытые — во
   вкладке «Закрытые».
3. **Ответ:** кнопка и/или свободный текст. Ответ **всегда** кладётся в файловую
   очередь (ключ идемпотентности создаётся один раз), затем отправляется
   `POST /v1/answers`; при ошибке остаётся в очереди и повторяется при следующем
   запуске/восстановлении сети. Повтор с тем же ключом сервер считает тем же
   ответом (`200`), дубля нет.
4. **Поток:** WebSocket `GET /v1/events` в foreground; ответ из другого канала
   (`question.answered`) закрывает вопрос, `question.expired` переносит в
   закрытые. При разрыве — переподключение с backoff.

## Ограничения MVP (осознанные)

- **APNs опционально:** нужен аккаунт разработчика и сертификат. Без пушей
  приложение получает ответы по WS только в foreground; при запуске/возврате в
  foreground делает `GET /v1/questions` и `flushQueue()` (фоновая проверка).
  Полноценный background-фетч (`BGTaskScheduler`) — следующий шаг: в MVP он не
  включён, чтобы не обещать доставку, которой нет без APNs.
- **e2e-шифрование** — задача 021: сейчас вопросы читаются в открытом режиме,
  `keyId` уже есть в модели привязки, конверт `enc` подключается позже.
- **Отвязка** очищает Keychain и локальную привязку; отзыв устройства на релее —
  через сервер (`DELETE /v1/devices/{id}`), в MVP-экране не автоматизирован.
- **Нет APNs-токена** — `registerDevice` отправляет только публичный ключ;
  `pushToken` появится вместе с APNs.
