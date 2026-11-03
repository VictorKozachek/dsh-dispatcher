#!/usr/bin/env bash
#
# Собрать манифест дочерних досок: `.kanban/children.json` в корне рабочей
# директории родительской сессии.
#
# Родительская команда (менеджер `backend`, тимлид `agents`) видит только свою
# доску. Манифест перечисляет доски дерева проектов — по нему вкладка «Дочерние
# доски» показывает сводку и открывает доски детей **только для чтения**. Сам
# скрипт ничего не пишет в доски детей: он лишь обходит дерево и складывает
# список путей.
#
# Дерево — это каталоги с тремя уровнями: `<board>/.kanban/tasks`. Обход идёт от
# `--root` (корень считается доской, если у него есть `.kanban/tasks`) и
# пропускает `node_modules`, `worktrees` и все скрытые каталоги (`.git`,
# `.idea`, `.worktrees` — они скрытые, поэтому отсекаются тем же правилом).
#
# Пути в манифесте относительные от `--base` (по умолчанию — `--root`): манифест
# с относительными путями переносим и годится для git. Доски вне `--base`
# (например, добавленные `--board`) пишутся абсолютными путями. `title` —
# последний сегмент пути доски; поле необязательное, но скрипт пишет его всегда,
# чтобы клиенту не приходилось догадываться.
#
# Повторный запуск идемпотентен: тот же вход → тот же файл (порядок путей
# сортируется, отметки времени в манифесте нет).
#
# Использование:
#   bin/board-children.sh --root DIR [--depth N] [--out FILE] [--print]
#                         [--base DIR] [--board PATH]...
#
#   --root DIR    корень обхода (по умолчанию — текущий каталог; нет каталога → 2)
#   --depth N     глубина вложенности досок: корень — уровень 0, доски на уровнях
#                 1..N (по умолчанию 4, допустимо 0…9; `0` — только корень)
#   --out FILE    куда писать манифест (по умолчанию <root>/.kanban/children.json)
#   --base DIR    от чего считать относительные пути (по умолчанию — --root)
#   --board PATH  добавить доску вне дерева (абсолютный путь или относительный
#                 от --root); можно повторять
#   --print       вывести манифест в stdout, файл не писать
#
# Коды возврата: 0 — ок; 1 — не удалось записать манифест; 2 — неверные
# аргументы или несуществующий --root/--base/--board.
#
set -euo pipefail

usage() {
  cat <<'EOF'
Использование:
  bin/board-children.sh --root DIR [--depth N] [--out FILE] [--print]
                        [--base DIR] [--board PATH]...

Собирает .kanban/children.json с досками дерева проектов: каталоги, где есть
.kanban/tasks. Скрытые каталоги, node_modules и worktrees пропускаются.

  --root DIR    корень обхода (по умолчанию — текущий каталог)
  --depth N     глубина вложенности досок: корень — уровень 0 (по умолчанию 4,
                допустимо 0…9; 0 — только корень)
  --out FILE    куда писать манифест (по умолчанию <root>/.kanban/children.json)
  --base DIR    от чего считать относительные пути (по умолчанию — --root;
                доски вне базы пишутся абсолютными)
  --board PATH  добавить доску вне дерева (абсолютный или от --root), можно повторять
  --print       вывести манифест в stdout, файл не писать

Коды возврата: 0 — ок; 1 — не удалось записать; 2 — неверные аргументы.
EOF
}

die_usage() {
  echo "$*" >&2
  exit 2
}

die_write() {
  echo "$*" >&2
  exit 1
}

# --- аргументы --------------------------------------------------------------

ROOT_ARG=""
DEPTH=4
OUT=""
BASE_ARG=""
PRINT_ONLY=0
EXTRA_BOARDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 && -n "${2:-}" ]] || die_usage "--root требует значения: --root DIR"
      ROOT_ARG="$2"; shift 2 ;;
    --root=*)
      ROOT_ARG="${1#*=}"; [[ -n "$ROOT_ARG" ]] || die_usage "--root требует значения: --root DIR"
      shift ;;
    --depth)
      [[ $# -ge 2 && -n "${2:-}" ]] || die_usage "--depth требует значения: --depth N"
      DEPTH="$2"; shift 2 ;;
    --depth=*)
      DEPTH="${1#*=}"; [[ -n "$DEPTH" ]] || die_usage "--depth требует значения: --depth N"
      shift ;;
    --out)
      [[ $# -ge 2 && -n "${2:-}" ]] || die_usage "--out требует значения: --out FILE"
      OUT="$2"; shift 2 ;;
    --out=*)
      OUT="${1#*=}"; [[ -n "$OUT" ]] || die_usage "--out требует значения: --out FILE"
      shift ;;
    --base)
      [[ $# -ge 2 && -n "${2:-}" ]] || die_usage "--base требует значения: --base DIR"
      BASE_ARG="$2"; shift 2 ;;
    --base=*)
      BASE_ARG="${1#*=}"; [[ -n "$BASE_ARG" ]] || die_usage "--base требует значения: --base DIR"
      shift ;;
    --board)
      [[ $# -ge 2 && -n "${2:-}" ]] || die_usage "--board требует значения: --board PATH"
      EXTRA_BOARDS+=("$2"); shift 2 ;;
    --board=*)
      EXTRA_BOARDS+=("${1#*=}"); shift ;;
    --print) PRINT_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die_usage "неизвестная опция: $1" ;;
    *) die_usage "лишний аргумент: $1 (путь задаётся через --root)" ;;
  esac
done

# --- что обходим ------------------------------------------------------------

[[ -n "$ROOT_ARG" ]] || ROOT_ARG="."
[[ -d "$ROOT_ARG" ]] || die_usage "нет каталога --root: $ROOT_ARG"
ROOT_DIR="$(cd "$ROOT_ARG" && pwd -P)"

if [[ ! "$DEPTH" =~ ^[0-9]+$ ]]; then
  die_usage "--depth: ожидается целое число 0…9 (получено: $DEPTH)"
fi
DEPTH="$((10#$DEPTH))"
if (( DEPTH > 9 )); then
  die_usage "--depth: допустимо 0…9 (получено: $DEPTH)"
fi

if [[ -n "$BASE_ARG" ]]; then
  [[ -d "$BASE_ARG" ]] || die_usage "нет каталога --base: $BASE_ARG"
  BASE_DIR="$(cd "$BASE_ARG" && pwd -P)"
else
  BASE_DIR="$ROOT_DIR"
fi

[[ -n "$OUT" ]] || OUT="$ROOT_DIR/.kanban/children.json"

# --- обход дерева -----------------------------------------------------------

# Каталоги, которые обход не трогает. Скрытые (`.git`, `.idea`, `.worktrees`)
# отсекаются отдельным правилом: `*` их и так не раскрывает, но `--board` может
# привести в такой каталог.
skip_dir() {
  case "$1" in
    .* | node_modules | worktrees) return 0 ;;
  esac
  return 1
}

boards=()

walk() {
  local dir="$1" level="$2" entry name
  if [[ -d "$dir/.kanban/tasks" ]]; then
    boards+=("$dir")
  fi
  (( level >= DEPTH )) && return 0
  for entry in "$dir"/*; do
    [[ -d "$entry" ]] || continue
    name="${entry##*/}"
    skip_dir "$name" && continue
    walk "$entry" $((level + 1))
  done
  return 0
}

walk "$ROOT_DIR" 0

# Явно заданные доски: абсолютные — как есть, относительные — от корня обхода.
for extra in ${EXTRA_BOARDS[@]+"${EXTRA_BOARDS[@]}"}; do
  if [[ "$extra" == /* ]]; then
    target="$extra"
  else
    target="$ROOT_DIR/$extra"
  fi
  [[ -d "$target" ]] || die_usage "нет каталога --board: $extra"
  target="$(cd "$target" && pwd -P)"
  if [[ ! -d "$target/.kanban/tasks" ]]; then
    echo "предупреждение: у доски $target нет .kanban/tasks" >&2
  fi
  boards+=("$target")
done

# --- пути и заголовки -------------------------------------------------------

# Путь доски от базы: относительный, если доска внутри базы, иначе абсолютный.
relative_to() {
  local board="$1"
  if [[ "$board" == "$BASE_DIR" ]]; then
    printf '.'
    return 0
  fi
  if [[ "$board" == "$BASE_DIR"/* ]]; then
    printf '%s' "${board#"$BASE_DIR"/}"
    return 0
  fi
  printf '%s' "$board"
}

# Строки «путь<TAB>заголовок», уникальные и отсортированные по пути. LC_ALL=C —
# сортировка и вывод не должны зависеть от локали вызывающего процесса.
entries() {
  local board
  for board in ${boards[@]+"${boards[@]}"}; do
    printf '%s\t%s\n' "$(relative_to "$board")" "${board##*/}"
  done | LC_ALL=C sort -u
}

count_boards() {
  entries | grep -c . || true
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Печать манифеста: без отметки времени, чтобы повторный запуск давал тот же файл.
manifest() {
  local path title first=1
  printf '{\n'
  printf '  "version": 1,\n'
  printf '  "boards": ['
  while IFS=$'\t' read -r path title; do
    [[ -n "$path" ]] || continue
    if (( first == 1 )); then
      printf '\n'
      first=0
    else
      printf ',\n'
    fi
    printf '    { "path": "%s", "title": "%s" }' "$(json_escape "$path")" "$(json_escape "$title")"
  done < <(entries)
  if (( first == 1 )); then
    printf ']\n'
  else
    printf '\n  ]\n'
  fi
  printf '}\n'
}

total="$(count_boards)"

# --- вывод ------------------------------------------------------------------

if (( PRINT_ONLY == 1 )); then
  manifest
  echo "досок: $total" >&2
  exit 0
fi

out_dir="$(dirname "$OUT")"
mkdir -p "$out_dir" 2>/dev/null || die_write "не удалось создать каталог для манифеста: $out_dir"
tmp="$OUT.tmp.$$"
if ! manifest > "$tmp" 2>/dev/null; then
  rm -f "$tmp"
  die_write "не удалось записать манифест: $OUT"
fi
if ! mv "$tmp" "$OUT" 2>/dev/null; then
  rm -f "$tmp"
  die_write "не удалось записать манифест: $OUT"
fi

echo "манифест: $total досок → $OUT"
while IFS=$'\t' read -r path title; do
  [[ -n "$path" ]] || continue
  printf '  %s (%s)\n' "$path" "$title"
done < <(entries)
