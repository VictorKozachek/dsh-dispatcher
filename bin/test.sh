#!/usr/bin/env bash
#
# Прогнать все проверки набора: логика доски, рендер компонента, синтаксис скриптов.
#
#   bin/test.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NODE="$ROOT/bin/node.sh"
if ! "$NODE" --which >/dev/null 2>&1; then
  echo "нужен node — см. подсказку bin/node.sh" >&2
  exit 1
fi
echo "node: $("$NODE" --which)"

echo "== логика доски (парсер, слияние с worktree)"
"$NODE" "$ROOT/dsh-kanban/test/parse.test.mjs"

echo "== рендер доски (регистрация в контексте, колонки, карточки)"
"$NODE" "$ROOT/dsh-kanban/test/render.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/watcher.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/delivery.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/assignment.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/card-actions.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/shutdown.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/presets.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/worktree-watch.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/mockup.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/merge.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/children.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/children-render.test.mjs"
"$NODE" "$ROOT/dsh-kanban/test/session-preset.test.mjs"

echo "== макет: проверки painter'а (высота карточки и предел чипа владельца)"
if command -v python3 >/dev/null 2>&1; then
  # python3 запоминаем ДО подмены PATH: каталог node (например
  # /opt/homebrew/bin) может содержать свой python3 без Pillow, и тогда проверка
  # падает на `import PIL`, хотя рабочий python3 в PATH есть (#056).
  PYTHON3="$(command -v python3)"
  PATH="$(dirname "$("$NODE" --which)"):$PATH" "$PYTHON3" "$ROOT/dsh-kanban/docs/check-mockup.py"
else
  echo "   python3 не найден — проверки painter'а пропущены"
fi

echo "== синтаксис скриптов"
for file in "$ROOT"/bin/*.sh; do
  bash -n "$file" || { echo "ошибка синтаксиса: $file" >&2; exit 1; }
done
echo "   все скрипты разбираются"

echo "== регрессии скриптов под системным bash (в macOS это 3.2)"
bash "$ROOT/bin/test-scripts.sh"

echo
echo "все проверки прошли"
