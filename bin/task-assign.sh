#!/usr/bin/env bash
#
# Асайн конкретной карточки: выбрать самого свободного исполнителя и выдать
# задачу — или вернуть её в очередь.
#
#   bin/task-assign.sh <id>              # асайн: backlog → todo --owner <самый свободный>
#   bin/task-assign.sh <id> --unassign   # возврат в очередь: todo → backlog
#   bin/task-assign.sh <id> --dry-run    # показать план и ничего не менять
#
# Кого асайнить: нагрузка исполнителя — карточки с этим `owner` в статусах
# `in-progress + in-review + testing` по слитому снимку доски; «занят» — у него
# есть карточка `in-progress`, такому асайн не делаем. Среди свободных берём с
# минимальной нагрузкой, при равенстве — первого по `.kanban/.workers.json`
# (порядок = приоритет; нет файла — единственный `worker` из
# `.kanban/.watcher-roles.json`).
#
# Снимок доски — тот же, что у сторожа (`dsh-kanban/lib/index.js`) и у
# `bin/backlog-fill.sh`: основной чекаут `.kanban/tasks/*.md` плюс доски рабочих
# деревьев `worktrees/*/.kanban/tasks/*.md` и `.worktrees/*/.kanban/tasks/*.md`.
# Из дерева берётся только одноимённая карточка `<name>.md` (унаследованные копии
# чужих карточек не считаются, файл с чужим `id` внутри отбрасывается), копии
# одной карточки сливаются по свежести `updated` (равенство — в пользу дерева).
# Карточка может жить в рабочем дереве: переход и коммит тогда делаются его
# собственной копией `bin/task-move.sh`, а не скриптом основного чекаута.
#
# Сам асайн и возврат идут через `bin/task-move.sh` — правила протокола остаются
# в одном месте, ручных правок front matter здесь нет. Ручной асайн не отменяет
# правил: асайн только свободному, одна карточка `in-progress` на агента.
#
# Коды возврата: 0 — асайн/возврат сделан (или `--dry-run` показал план);
# 1 — ошибка конфига или доски; 2 — ошибка использования; 3 — карточка не найдена
# или не в том статусе для этого режима; 4 — нет свободных исполнителей.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASKS_DIR="$ROOT/.kanban/tasks"
WORKERS_FILE="$ROOT/.kanban/.workers.json"
ROLES_FILE="$ROOT/.kanban/.watcher-roles.json"

usage() {
  cat <<'EOF'
Использование:
  bin/task-assign.sh <id> [--dry-run] [--unassign]

Асайн карточки: переводит её из backlog в todo и закрепляет за самым свободным
исполнителем (минимум карточек в конвейере in-progress + in-review + testing;
занятым, у кого есть in-progress, асайн не делается). Пул — .kanban/.workers.json
(порядок = приоритет), fallback — worker из .kanban/.watcher-roles.json.

  --unassign  вернуть карточку в очередь: todo → backlog, владелец и роль снимаются
  --dry-run   показать план (карточка, где лежит, статус, нагрузки) и ничего не менять

Коды возврата: 0 — ок; 1 — ошибка конфига/доски; 2 — ошибка использования;
3 — карточка не найдена или не в том статусе; 4 — нет свободных исполнителей.
EOF
}

ID=""
DRY_RUN=0
UNASSIGN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --unassign) UNASSIGN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "неизвестная опция: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "$ID" ]]; then
        echo "лишний аргумент: $1 (ожидалась одна карточка)" >&2
        exit 2
      fi
      ID="${1#\#}"
      shift ;;
  esac
done

if [[ -z "$ID" ]]; then
  echo "не указана карточка: bin/task-assign.sh <id> [--dry-run] [--unassign]" >&2
  exit 2
fi
if [[ ! "$ID" =~ ^[0-9]+$ ]]; then
  echo "номер карточки должен быть числом (получено: $ID)" >&2
  exit 2
fi
# Имена файлов карточек — `%03d.md`: `46` и `046` это одна карточка.
ID="$(printf '%03d' "$((10#$ID))")"

die_config() {
  echo "$*" >&2
  exit 1
}

# --- снимок доски -----------------------------------------------------------
# Помощники нарочно повторяют `bin/backlog-fill.sh`: у скриптов набора нет общей
# библиотеки, а образец семантики — сторож (`dsh-kanban/lib/index.js`). Если
# появится третий потребитель, слияние стоит вынести в общий файл.

# Значение поля front matter карточки (первый блок между `---`).
card_field() {
  awk -v key="$2" '
    NR == 1 && $0 == "---" { infm = 1; next }
    infm == 1 && $0 == "---" { exit }
    infm == 1 && index($0, key ":") == 1 {
      sub("^" key ":[[:space:]]*", "");
      gsub(/^"|"$/, "");
      sub(/[[:space:]]+$/, "");
      print;
      exit
    }' "$1"
}

# Статус в том же виде, в каком его понимает доска (регистр, пробелы, синонимы).
card_status() {
  local raw
  raw="$(card_field "$1" status | tr '[:upper:]' '[:lower:]' | tr -s ' ' '-')"
  case "$raw" in
    "" | new | "нужно-сделать") printf '%s' "todo" ;;
    in_progress | progress | wip | doing | active | "в-работе") printf '%s' "in-progress" ;;
    in_review | inreview | "code-review" | reviewing | review | "на-ревью" | "ревью") printf '%s' "in-review" ;;
    test | verify | "на-проверке" | "тестирование") printf '%s' "testing" ;;
    "ready-to-merge" | done | "готово") printf '%s' "ready" ;;
    "влито" | "слито" | closed) printf '%s' "merged" ;;
    hold | "заблокировано") printf '%s' "blocked" ;;
    *) printf '%s' "$raw" ;;
  esac
}

# Идентификатор карточки: поле `id`, иначе имя файла.
card_id() {
  local id
  id="$(card_field "$1" id)"
  printf '%s' "${id:-$(basename "$1" .md)}"
}

# Карточка с front matter: файл начинается с `---`.
card_ok() {
  local first=""
  IFS= read -r first < "$1" || true
  [[ "${first%$'\r'}" == "---" ]]
}

# Карточки со всех досок проекта: `<из дерева 0|1>\t<путь>\t<id>\t<updated>`.
board_card_files() {
  local file trees dir name
  for file in "$TASKS_DIR"/[0-9]*.md; do
    [[ -e "$file" ]] || continue
    card_ok "$file" || continue
    printf '0\t%s\t%s\t%s\n' "$file" "$(card_id "$file")" "$(card_field "$file" updated)"
  done
  for trees in worktrees .worktrees; do
    [[ -d "$ROOT/$trees" ]] || continue
    for dir in "$ROOT/$trees"/*/.kanban/tasks; do
      [[ -d "$dir" ]] || continue
      name="${dir%/.kanban/tasks}"
      name="${name##*/}"
      file="$dir/$name.md"
      [[ -f "$file" ]] || continue
      card_ok "$file" || continue
      # Живая карточка дерева — ровно та, что названа каталогом.
      [[ "$(card_id "$file")" == "$name" ]] || continue
      printf '1\t%s\t%s\t%s\n' "$file" "$(card_id "$file")" "$(card_field "$file" updated)"
    done
  done
}

# Снимок доски: одна живая копия на карточку, по возрастанию id.
# Формат строки — `<id>\t<путь>\t<из дерева 0|1>`.
build_snapshot() {
  SNAPSHOT_FILE="$(mktemp "${TMPDIR:-/tmp}/kanban-assign.XXXXXX")"
  board_card_files | awk -F '\t' '
    function newer(cand, candTree, cur, curTree) {
      if (cand != "" && cur != "") {
        if (cand == cur) return (candTree + 0)
        return (cand > cur)
      }
      if (cand != "") return 1
      if (cur != "") return 0
      return (candTree + 0)
    }
    {
      id = $3
      if (!(id in seen)) {
        seen[id] = 1
        order[++total] = id
        bestPath[id] = $2
        bestUpdated[id] = $4
        bestTree[id] = $1
        next
      }
      if (newer($4, $1, bestUpdated[id], bestTree[id])) {
        bestPath[id] = $2
        bestUpdated[id] = $4
        bestTree[id] = $1
      }
    }
    END {
      for (i = 1; i <= total; i++) printf "%s\t%s\t%s\n", order[i], bestPath[order[i]], bestTree[order[i]]
    }
  ' | LC_ALL=C sort > "$SNAPSHOT_FILE"
}

# Временные файлы снимка и нагрузок: они не нужны после выхода.
cleanup() {
  [[ -n "${SNAPSHOT_FILE:-}" ]] && rm -f "$SNAPSHOT_FILE"
  [[ -n "${LOAD_POOL_FILE:-}" ]] && rm -f "$LOAD_POOL_FILE"
  [[ -n "${LOAD_ROWS_FILE:-}" ]] && rm -f "$LOAD_ROWS_FILE"
  [[ -n "${LOADS_FILE:-}" ]] && rm -f "$LOADS_FILE"
  # Свой статус уборки не важен: код возврата скрипта сохраняет on_exit.
  return 0
}

# EXIT-ловушка не должна затирать код возврата. Раньше ловушка звала cleanup
# напрямую, и `return 0` в нём превращал любой сбой в успех: GUI показывал
# «перенесено», а карточка не двигалась (#056). Теперь статус запоминается ДО
# уборки и возвращается после неё.
on_exit() {
  local code=$?
  cleanup || true
  exit "$code"
}

# Где лежит карточка — для текста плана.
card_where() {
  local file="$1" from_tree="$2" tasks_dir tree_root
  if [[ "$from_tree" != "1" ]]; then
    printf '%s' "основной чекаут"
    return 0
  fi
  tasks_dir="$(dirname "$file")"
  tree_root="$(dirname "$(dirname "$tasks_dir")")"
  printf '%s' "${tree_root#"$ROOT"/}"
}

# Чем двигать карточку: карточка рабочего дерева живёт в его ветке, и скрипт
# основного чекаута её не найдёт — у дерева своя копия `bin/task-move.sh`.
mover_for() {
  local file="$1" from_tree="$2" tasks_dir tree_root
  if [[ "$from_tree" == "1" ]]; then
    tasks_dir="$(dirname "$file")"
    tree_root="$(dirname "$(dirname "$tasks_dir")")"
    printf '%s' "$tree_root/bin/task-move.sh"
    return 0
  fi
  printf '%s' "$ROOT/bin/task-move.sh"
}

# --- пул исполнителей -------------------------------------------------------

# Пул: `.workers.json` (массив строк), иначе единственный `worker` из
# `.watcher-roles.json`. Битый JSON — код 1, как у `bin/backlog-fill.sh`.
WORKERS=()
read_workers() {
  if [[ -f "$WORKERS_FILE" ]]; then
    local body built sep id
    body="$(tr -d '[:space:]' < "$WORKERS_FILE" 2>/dev/null || true)"
    case "$body" in
      \[*\]) ;;
      *) die_config "битый JSON в $WORKERS_FILE: ожидался массив [\"session-id\", ...]" ;;
    esac
    built="["
    sep=""
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      built="$built$sep\"$id\""
      sep=","
      WORKERS+=("$id")
    done < <(printf '%s' "$body" | grep -o '"[^"]*"' | tr -d '"' || true)
    built="$built]"
    if [[ "$built" != "$body" ]]; then
      die_config "битый JSON в $WORKERS_FILE: ожидался массив строк в кавычках, без лишних символов"
    fi
    return 0
  fi
  if [[ -f "$ROLES_FILE" ]]; then
    local worker
    worker="$(sed -n 's/.*"worker"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROLES_FILE" | head -1)"
    if [[ -n "$worker" ]]; then
      WORKERS+=("$worker")
    fi
  fi
}

# Нагрузки по снимку: для каждого исполнителя пула — `<id>\t<в конвейере>\t<занят>`.
# Нагрузка — карточки этого владельца в `in-progress + in-review + testing`;
# «занят» — есть карточка `in-progress` (такому асайн не делаем). Порядок строк —
# порядок пула, поэтому равенство нагрузки решается приоритетом пула.
LOAD_POOL_FILE=""
LOAD_ROWS_FILE=""
LOADS_FILE=""
build_loads() {
  local id file from_tree owner status
  LOAD_POOL_FILE="$(mktemp "${TMPDIR:-/tmp}/kanban-pool.XXXXXX")"
  LOAD_ROWS_FILE="$(mktemp "${TMPDIR:-/tmp}/kanban-load.XXXXXX")"
  LOADS_FILE="$(mktemp "${TMPDIR:-/tmp}/kanban-loads.XXXXXX")"
  : > "$LOAD_POOL_FILE"
  local candidate
  for candidate in ${WORKERS[@]+"${WORKERS[@]}"}; do
    printf '%s\n' "$candidate" >> "$LOAD_POOL_FILE"
  done
  : > "$LOAD_ROWS_FILE"
  while IFS=$'\t' read -r id file from_tree; do
    owner="$(card_field "$file" owner)"
    [[ -n "$owner" ]] || continue
    status="$(card_status "$file")"
    case "$status" in
      in-progress | in-review | testing) ;;
      *) continue ;;
    esac
    printf '%s\t%s\n' "$owner" "$status" >> "$LOAD_ROWS_FILE"
  done < "$SNAPSHOT_FILE"
  # Пул передаём значением через окружение, а не вторым файлом: различать файлы
  # по `FNR == NR` нельзя — при пустом пуле (нет обоих файлов или `[]`) первый же
  # ряд строк нагрузки выглядел бы пулом, и проверка занятости отключалась.
  KANBAN_ASSIGN_POOL="$(cat "$LOAD_POOL_FILE")" awk -F '\t' '
    BEGIN {
      pool = ENVIRON["KANBAN_ASSIGN_POOL"]
      if (pool != "") {
        n = split(pool, ids, "\n")
        for (i = 1; i <= n; i++) {
          if (ids[i] == "" || seen[ids[i]]++) continue
          order[++total] = ids[i]
          load[ids[i]] = 0
          busy[ids[i]] = 0
        }
      }
    }
    {
      who = $1
      if (!(who in load)) next
      if ($2 == "in-progress") busy[who] = 1
      load[who]++
    }
    END {
      for (i = 1; i <= total; i++) printf "%s\t%d\t%d\n", order[i], load[order[i]], busy[order[i]]
    }
  ' "$LOAD_ROWS_FILE" > "$LOADS_FILE"
}

# Таблица нагрузок для плана: по строке на исполнителя.
print_loads() {
  local who load busy mark
  while IFS=$'\t' read -r who load busy; do
    mark=""
    [[ "$busy" == "1" ]] && mark=" (занят: есть in-progress)"
    printf '  %s: в конвейере %s%s\n' "$who" "$load" "$mark"
  done < "$LOADS_FILE"
}

# --- асайн и возврат --------------------------------------------------------

if [[ ! -d "$TASKS_DIR" ]]; then
  die_config "нет каталога карточек: $TASKS_DIR"
fi

SNAPSHOT_FILE=""
trap on_exit EXIT
build_snapshot

card_file=""
card_from_tree=""
while IFS=$'\t' read -r id file from_tree; do
  if [[ "$id" == "$ID" ]]; then
    card_file="$file"
    card_from_tree="$from_tree"
    break
  fi
done < "$SNAPSHOT_FILE"

if [[ -z "$card_file" ]]; then
  echo "карточка #$ID не найдена: нет ни в основном чекауте, ни в рабочих деревьях" >&2
  exit 3
fi

status="$(card_status "$card_file")"
title="$(card_field "$card_file" title)"
owner="$(card_field "$card_file" owner)"
where="$(card_where "$card_file" "$card_from_tree")"
# Подпись карточки: «…#ID «название»». Собираем через printf, а не одной
# строкой: в локали C.UTF-8 системный bash 3.2 съедает мультибайт, стоящий сразу
# после `$title`, и падает с `title?: unbound variable` (#056).
label="#$ID"
if [[ -n "$title" ]]; then
  label="$(printf '%s «%s»' "$label" "$title")"
fi

if (( UNASSIGN == 1 )); then
  if [[ "$status" != "todo" ]]; then
    case "$status" in
      in-progress) echo "карточка $label в in-progress: её уже взяли в работу — вернуть в backlog можно только из todo" >&2 ;;
      backlog) echo "карточка $label уже в backlog: возвращать нечего" >&2 ;;
      *) echo "карточка $label в статусе $status: вернуть в backlog можно только из todo" >&2 ;;
    esac
    exit 3
  fi
  echo "карточка: $label — $where"
  echo "статус: todo"
  echo "владелец: ${owner:-(нет)}"
  if (( DRY_RUN == 1 )); then
    echo "вернул бы: #$ID → backlog, владелец и роль снимаются"
    exit 0
  fi
  if ! "$(mover_for "$card_file" "$card_from_tree")" "$ID" backlog >/dev/null 2>&1; then
    echo "bin/task-move.sh отказал в возврате #$ID в backlog" >&2
    exit 1
  fi
  echo "возврат: #$ID → backlog, владелец и роль сняты"
  exit 0
fi

if [[ "$status" != "backlog" ]]; then
  echo "карточка $label в статусе $status: асайн делается только из backlog" >&2
  if [[ "$status" == "in-progress" ]]; then
    echo "её уже взяли в работу — асайн не нужен" >&2
  fi
  exit 3
fi

read_workers

# Пустой пул — не «все заняты»: разбирать нагрузки не по кому, и асайн должен
# отказать с подсказкой, а не искать кандидатов среди владельцев карточек.
if (( ${#WORKERS[@]} == 0 )); then
  echo "карточка: $label — $where"
  echo "статус: backlog"
  echo "нагрузки:"
  echo "нет свободных: пул исполнителей пуст — заведите .kanban/.workers.json или worker в .kanban/.watcher-roles.json" >&2
  exit 4
fi

build_loads

chosen=""
chosen_load=""
while IFS=$'\t' read -r who load busy; do
  [[ "$busy" == "1" ]] && continue
  if [[ -z "$chosen" ]] || (( load < chosen_load )); then
    chosen="$who"
    chosen_load="$load"
  fi
done < "$LOADS_FILE"

echo "карточка: $label — $where"
echo "статус: backlog"
echo "нагрузки:"
print_loads

if [[ -z "$chosen" ]]; then
  echo "все заняты: у каждого исполнителя есть карточка in-progress — асайн невозможен, карточка осталась в backlog" >&2
  exit 4
fi

echo "исполнитель: $chosen (нагрузка $chosen_load)"

if (( DRY_RUN == 1 )); then
  echo "выдал бы: #$ID → $chosen, статус todo"
  exit 0
fi

if ! "$(mover_for "$card_file" "$card_from_tree")" "$ID" todo --owner "$chosen" --role worker >/dev/null 2>&1; then
  echo "bin/task-move.sh отказал в асайне #$ID на $chosen" >&2
  exit 1
fi
echo "выдано: #$ID → $chosen, статус todo"
