#!/bin/bash
# Дамп доски: колонки и карточки (разбор — из плагина, см. bin/board-status.mjs).
#
#   bin/board-status.sh                # доска текущего проекта
#   bin/board-status.sh --json         # то же машинно
#   bin/board-status.sh --root DIR     # доска другого проекта
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$("$ROOT/bin/node.sh" --which)"
exec "$NODE" "$ROOT/bin/board-status.mjs" --root "$ROOT" "$@"
