# Эталонные реализации e2e (задача 021)

Криптослой релея в трёх реализациях: JS — рабочий код плагина
(`dsh-remote/lib/crypto.js`), Kotlin и Swift — эталоны для клиентов (Android 019 /
iOS 020). Все три проверяются одним файлом векторов
[`../test-vectors.json`](../test-vectors.json); тесты обязаны совпасть с ним
байт-в-байт.

Почему Kotlin/Swift лежат здесь, а не в `apps/`: к моменту сдачи 021 в основной
ветке уже есть `apps/android` (019 смержен), но `apps/ios` ещё нет (020 в backlog),
а добавление криптослоя в чужой Gradle-проект потребовало бы тянуть Android SDK в
проверку этой задачи. Поэтому здесь отдельный самостоятельный прогон векторов:
клиенты (019/020) переносят код в свои проекты без изменения логики — меняется
только хранение ключа (Keystore/Keychain вместо конфига) и появляется UI для
ввода публичного ключа плагина.

Схема и обоснование — [`../CRYPTO.md`](../CRYPTO.md).

## Прогоны

JS (плагин):

```bash
node --test dsh-remote/test/crypto.spec.js
```

Kotlin/JVM (X25519 и ChaCha20-Poly1305 из JDK 21, org.json, JUnit):

```bash
cd docs/relay/impl/kotlin
./gradlew test
```

Swift (CryptoKit, Swift 5.9+):

```bash
cd docs/relay/impl/swift
swift test
```

В песочнице агента (`workspace-write`) SwiftPM нужно увести кеши в дерево и
отключить его собственный sandbox, иначе clang-кеш и `sandbox_apply` упираются в
чужие права:

```bash
mkdir -p .build/tmp
TMPDIR="$PWD/.build/tmp" \
CLANG_MODULE_CACHE_PATH="$PWD/.build/clang-module-cache" \
SWIFT_MODULECACHE_PATH="$PWD/.build/swift-module-cache" \
swift test --disable-sandbox --cache-path .build/cache --config-path .build/config --security-path .build/security
```

Gradle в песочнице тоже требует свой `GRADLE_USER_HOME` внутри дерева:

```bash
GRADLE_USER_HOME="$PWD/.gradle/gruser" ./gradlew test
```

## Что проверяют тесты

- 7 валидных векторов: вопрос/ответ, ChaCha20-Poly1305 и AES-256-GCM, кириллица
  и эмодзи — шифрование с заданным nonce совпадает с вектором байт-в-байт,
  расшифровка возвращает канонический plaintext;
- 6 негативных: подмена `enc`, чужой AAD (подменённые метаданные), чужой `keyId`,
  короткий nonce, незнакомый `alg`, неверный `plainSize` — падают с тем же
  машинным кодом, что и JS (`decrypt-failed`, `key-mismatch`, `bad-envelope`,
  `unsupported-alg`);
- round-trip обоих алгоритмов, формат ключей и стабильность `keyId`;
- вопрос, зашифрованный для другого устройства, не расшифровывается.

## Перегенерация векторов

```bash
node docs/relay/gen-test-vectors.mjs
```

Генератор детерминированный (nonce = sha256 от имени вектора), поэтому повторный
запуск не меняет криптографическую часть файла. Ключи в векторах тестовые.
