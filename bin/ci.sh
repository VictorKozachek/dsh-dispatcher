#!/usr/bin/env bash
#
# Прогнать все проверки проекта локально — то же, что делает CI на GitHub.
#
#   bin/ci.sh [--fast] [--android] [--no-rust] [--no-swift]
#
#   --fast     только плагин и скрипты (секунды)
#   --android  дополнительно юнит-тесты Android-приложения (нужен Android SDK)
#   --no-rust  пропустить релей
#   --no-swift пропустить Swift-пакеты
#
# Зачем локально: workflow на GitHub требует у токена scope `workflow`, а до его
# появления CI живёт здесь. Скрипт — тот же набор проверок, что в
# .github/workflows/ci.yml (когда тот заработает, дублирование безвредно).
#
# Кэши cargo/gradle/swift направляются внутрь проекта: в песочнице DSH домашние
# каталоги (`~/.cargo`, `~/.gradle`, `~/Library/...`) недоступны на запись.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/.ci-cache"
FAST=0
ANDROID=0
RUST=1
SWIFT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast) FAST=1; shift ;;
    --android) ANDROID=1; shift ;;
    --no-rust) RUST=0; shift ;;
    --no-swift) SWIFT=0; shift ;;
    -h|--help)
      sed -n '3,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
      exit 0
      ;;
    *) echo "неизвестная опция: $1" >&2; exit 2 ;;
  esac
done

cd "$ROOT"
NODE="$ROOT/bin/node.sh"
FAILED=()
STEP=0

run() {
  local name="$1"; shift
  STEP=$((STEP + 1))
  echo
  echo "== [$STEP] $name"
  if "$@"; then
    echo "   ok"
  else
    echo "   ПРОВАЛ: $name" >&2
    FAILED+=("$name")
  fi
}

plugin_tests() {
  # Изоляция от живого ~/.dsh: подменяем DSH_HOME на временный каталог, иначе
  # тесты видят настоящую привязку бота и поднимают второй поллер.
  local home
  home="$(mktemp -d "${TMPDIR:-/tmp}/dsh-remote-ci.XXXXXX")"
  DSH_HOME="$home" "$NODE" --test dsh-remote/test/*.spec.js
  local status=$?
  rm -rf "$home"
  return $status
}

scripts_syntax() {
  local file
  for file in bin/*.sh deploy/*.sh; do
    bash -n "$file" || return 1
  done
  echo "все скрипты разбираются"
}

relay_tests() {
  command -v cargo >/dev/null 2>&1 || { echo "cargo нет — пропущено"; return 0; }
  (
    cd relay
    CARGO_HOME="$CACHE/cargo" CARGO_TARGET_DIR="$CACHE/cargo-target" cargo test --all-targets
  )
}

swift_tests() {
  command -v swift >/dev/null 2>&1 || { echo "swift нет — пропущено"; return 0; }
  local pkg
  for pkg in apps/ios docs/relay/impl/swift; do
    echo "-- $pkg"
    (
      TMPDIR="$CACHE/tmp" \
      CLANG_MODULE_CACHE_PATH="$CACHE/swift-modules" \
      SWIFT_MODULE_CACHE_PATH="$CACHE/swift-modules" \
      swift test --disable-sandbox --package-path "$pkg" --scratch-path "$CACHE/swift-$(
        printf '%s' "$pkg" | tr '/' '-'
      )" >/dev/null
    ) || return 1
    echo "   $pkg: тесты прошли"
  done
}

kotlin_vectors() {
  [[ -x docs/relay/impl/kotlin/gradlew ]] || { echo "gradlew нет — пропущено"; return 0; }
  command -v java >/dev/null 2>&1 || { echo "java нет — пропущено"; return 0; }
  (
    cd docs/relay/impl/kotlin
    GRADLE_USER_HOME="$CACHE/gradle" ./gradlew test --console=plain -q
  )
}

android_tests() {
  if [[ ! -x apps/android/gradlew ]]; then echo "gradlew нет — пропущено"; return 0; fi
  if ! command -v java >/dev/null 2>&1; then echo "java нет — пропущено"; return 0; fi
  (
    cd apps/android
    GRADLE_USER_HOME="$CACHE/gradle" ./gradlew test --console=plain -q
  )
}

mkdir -p "$CACHE/tmp" "$CACHE/swift-modules" "$CACHE/cargo" "$CACHE/cargo-target" "$CACHE/gradle"

run "плагин dsh-remote (node --test)" plugin_tests
run "синтаксис скриптов (bash -n)" scripts_syntax
run "крипто-векторы Kotlin" kotlin_vectors

if (( FAST == 0 )); then
  (( RUST == 1 )) && run "релей (cargo test)" relay_tests
  (( SWIFT == 1 )) && run "Swift-пакеты (swift test)" swift_tests
fi

if (( ANDROID == 1 )); then
  run "Android (gradlew test)" android_tests
fi

echo
if (( ${#FAILED[@]} == 0 )); then
  echo "все проверки прошли"
else
  echo "провалено: ${FAILED[*]}" >&2
  exit 1
fi
