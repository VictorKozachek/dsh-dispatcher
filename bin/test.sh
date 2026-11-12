#!/usr/bin/env bash
#
# Прогнать все проверки проекта: тесты плагина и синтаксис скриптов.
#
#   bin/test.sh
#
# Тесты плагина лежат в dsh-remote/test (node:test, без сети). Пока плагин не
# заведён (задача 001), шаг тестов пропускается с предупреждением.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NODE="$ROOT/bin/node.sh"
if ! "$NODE" --which >/dev/null 2>&1; then
  echo "нужен node — см. подсказку bin/node.sh" >&2
  exit 1
fi
echo "node: $("$NODE" --which)"

echo "== тесты плагина dsh-remote"
# Изоляция: тесты не должны видеть живое состояние пользователя
# (~/.dsh/remote-control) и живые секреты — иначе плагин при прогоне поднимает
# настоящий поллер бота, а тесты зависят от машины, где их запустили.
export DSH_HOME
DSH_HOME="$(mktemp -d "${TMPDIR:-/tmp}/dsh-remote-test.XXXXXX")"
trap 'rm -rf "$DSH_HOME"' EXIT
if [[ -d "$ROOT/dsh-remote/test" ]]; then
  "$NODE" --test "$ROOT/dsh-remote/test"/*.spec.js
else
  echo "   плагина ещё нет — пропущено"
fi

echo "== синтаксис скриптов"
for file in "$ROOT"/bin/*.sh; do
  bash -n "$file" || { echo "ошибка синтаксиса: $file" >&2; exit 1; }
done
echo "   все скрипты разбираются"

echo
echo "все проверки прошли"
