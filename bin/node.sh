#!/usr/bin/env bash
#
# Найти Node и выполнить его: тесты и макеты не должны зависеть от PATH сессии.
#
#   bin/node.sh <аргументы node...>   # выполнить найденный node
#   bin/node.sh --which               # напечатать путь к найденному node
#
# Порядок поиска:
#   1. $DSH_NODE — явное переопределение (сломанный путь — громкий отказ);
#   2. node из PATH;
#   3. Node внутри приложения DSH
#      (runtime/primary-runtime/dependencies/node/bin/node) — та же версия,
#      что у рантайма: тесты плагина идут на том же Node, что и в бою;
#   4. /opt/homebrew/bin/node, /usr/local/bin/node — обычные установки;
#   5. шим приложения runtime/bin/node — годится, когда задан
#      DSH_DESKTOP_NODE_EXECUTABLE, то есть внутри процессов приложения.
#
# Почему не просто `node`: сессии DSH получают урезанный PATH
# (/usr/bin:/bin:/usr/sbin:/sbin), и Homebrew-ноды в нём нет.
#
set -euo pipefail

APP_ROOT="/Applications/DeepSeek Harness.app/Contents/Resources/runtime"
APP_NODE="$APP_ROOT/primary-runtime/dependencies/node/bin/node"
APP_SHIM="$APP_ROOT/bin/node"

resolve() {
  if [[ -n "${DSH_NODE:-}" ]]; then
    if [[ -x "${DSH_NODE}" ]]; then
      printf '%s' "$DSH_NODE"
      return 0
    fi
    echo "DSH_NODE указывает на неисполняемый файл: $DSH_NODE" >&2
    return 1
  fi

  local found
  found="$(command -v node 2>/dev/null || true)"
  if [[ -n "$found" && -x "$found" ]]; then
    printf '%s' "$found"
    return 0
  fi

  if [[ -x "$APP_NODE" ]]; then
    printf '%s' "$APP_NODE"
    return 0
  fi

  local candidate
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  if [[ -n "${DSH_DESKTOP_NODE_EXECUTABLE:-}" && -x "$APP_SHIM" ]]; then
    printf '%s' "$APP_SHIM"
    return 0
  fi

  return 1
}

if [[ "${1:-}" == "--which" ]]; then
  if path="$(resolve)"; then
    printf '%s\n' "$path"
    exit 0
  fi
  echo "Node не найден; задайте путь явно: DSH_NODE=/путь/к/node $0 --which" >&2
  exit 1
fi

if ! node_path="$(resolve)"; then
  cat >&2 <<'MSG'
Node не найден. Варианты:
  * задать путь явно:  DSH_NODE=/путь/к/node bin/test.sh
  * поставить Node:    brew install node
  * запускать внутри приложения DSH — там Node лежит в его runtime
MSG
  exit 1
fi

exec "$node_path" "$@"
