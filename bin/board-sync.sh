#!/usr/bin/env bash
#
# Собрать манифест открытых карточек из worktree: .kanban/worktrees.json.
#
# Запускается ТОЛЬКО из основного чекаута. Зачем он вообще нужен: доска и так
# обходит <проект>/worktrees/<id> и показывает незакрытые задачи сама, поэтому
# манифест нужен лишь для рабочих деревьев ВНЕ проекта — там листинг за пределы
# workspace не работает, а чтение по абсолютному пути работает.
#
# Пути в манифесте: для деревьев внутри проекта — относительные (совпадают с тем,
# что доска находит обходом, и не читаются дважды), для внешних — абсолютные.
#
# Использование:
#   bin/board-sync.sh          # обновить манифест
#   bin/board-sync.sh --print  # только показать, что нашлось
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/.kanban/worktrees.json"
PRINT_ONLY=0
[[ "${1:-}" == "--print" ]] && PRINT_ONLY=1

if ! git -C "$ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "не git-репозиторий: манифест не нужен, доска читает карточки этого каталога" >&2
  exit 0
fi

# Основной чекаут — это ПЕРВАЯ запись `git worktree list`, а не
# `rev-parse --show-toplevel`: из рабочего дерева задачи второй вернёт само это
# дерево, и скрипт молча записал бы пустой манифест.
main_root="$(git -C "$ROOT" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
if [[ -z "$main_root" ]]; then
  echo "не удалось определить основной рабочий каталог" >&2
  exit 1
fi
# Сравниваем физические пути: git отдаёт /private/var/..., а BASH_SOURCE может
# дать /var/... — это один и тот же каталог, и проверка не должна на этом падать.
root_physical="$(cd "$ROOT" 2>/dev/null && pwd -P || printf '%s' "$ROOT")"
main_physical="$(cd "$main_root" 2>/dev/null && pwd -P || printf '%s' "$main_root")"
if [[ "$root_physical" != "$main_physical" ]]; then
  cat >&2 <<'MSG'
board-sync.sh запускается только из ОСНОВНОГО чекаута: он пишет манифест в
<проект>/.kanban/worktrees.json, а не в рабочее дерево задачи.

Доска и так видит задачи из <проект>/worktrees/<id> — синхронизация нужна только
для рабочих деревьев ВНЕ проекта. Запустите из основного каталога:

  cd "$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
  bin/board-sync.sh
MSG
  exit 1
fi

cards=()
worktree=""
branch=""
flush() {
  [[ -n "$worktree" ]] || return 0
  # Основной чекаут доска читает сама — в манифест он не нужен.
  if [[ "$worktree" == "$main_root" ]]; then worktree=""; branch=""; return 0; fi

  local id=""
  case "$branch" in
    refs/heads/feature/*) id="${branch##refs/heads/feature/}" ;;
    refs/heads/bug/*) id="${branch##refs/heads/bug/}" ;;
    refs/heads/task/*) id="${branch##refs/heads/task/}" ;;
    *) id="$(basename "$worktree" | sed -n 's/.*-t\([0-9][0-9]*\)$/\1/p')" ;;
  esac
  if [[ "$id" =~ ^[0-9]+$ ]]; then
    local card="$worktree/.kanban/tasks/$id.md"
    if [[ -f "$card" ]]; then
      # Карточка внутри проекта пишется относительным путём: тогда она совпадает
      # с тем, что доска находит сама обходом .worktrees/, и не читается дважды.
      local relative="${card#"$main_root"/}"
      [[ "$relative" != "$card" ]] && card="$relative"
      cards+=("$card")
    fi
  fi
  worktree=""
  branch=""
}

while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    worktree\ *) flush; worktree="${line#worktree }" ;;
    branch\ *) branch="${line#branch }" ;;
    "") flush ;;
  esac
done < <(git -C "$ROOT" worktree list --porcelain)
flush

stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

if (( PRINT_ONLY == 1 )); then
  if (( ${#cards[@]} == 0 )); then
    echo "открытых карточек в worktree нет"
  else
    printf '%s\n' "${cards[@]}"
  fi
  exit 0
fi

mkdir -p "$(dirname "$MANIFEST")"
{
  printf '{\n'
  printf '  "version": 1,\n'
  printf '  "updated": "%s",\n' "$stamp"
  printf '  "cards": ['
  if (( ${#cards[@]} == 0 )); then
    printf ']\n'
  else
    printf '\n'
    for index in "${!cards[@]}"; do
      printf '    "%s"' "$(json_escape "${cards[$index]}")"
      if (( index + 1 < ${#cards[@]} )); then printf ',\n'; else printf '\n'; fi
    done
    printf '  ]\n'
  fi
  printf '}\n'
} > "$MANIFEST"

echo "манифест обновлён: ${MANIFEST#"$ROOT"/} (карточек из worktree: ${#cards[@]})"
if (( ${#cards[@]} > 0 )); then
  printf '  %s\n' "${cards[@]}"
fi
