#!/usr/bin/env bash
#
# Пополнить `todo` из `backlog`: выдать нарезанные задачи свободным исполнителям.
#
#   bin/backlog-fill.sh              # выдать, пока todo не доберёт до minTodo
#   bin/backlog-fill.sh --dry-run    # показать план, ничего не меняя
#   bin/backlog-fill.sh --min N      # переопределить минимум на этот запуск
#
# Запускает оркестратор (полуавтомат: «задачу выдаёт оркестратор», см. AGENTS.md).
#
# Конфиг минимума — `.kanban/board.json` (tracked): `{ "minTodo": 2 }`. Файла нет —
# минимум 1; битый JSON или нечисловое значение — внятная ошибка и код 1.
#
# Пул исполнителей — `.kanban/.workers.json` (в `.gitignore`): упорядоченный
# массив id сессий, порядок = приоритет выдачи. Файла нет — берётся `worker` из
# `.kanban/.watcher-roles.json`. Свободен тот, у кого нет карточки `in-progress`;
# только что выданная в этом прогоне задача тоже считается занятостью — иначе
# обе карточки уехали бы первому исполнителю.
#
# Занятость и счёт `todo`/`backlog` считаются по снимку доски: основной чекаут
# `.kanban/tasks/*.md` плюс рабочие деревья `worktrees/*/.kanban/tasks/*.md` и
# `.worktrees/*/.kanban/tasks/*.md`. Из дерева берётся только одноимённая
# карточка `<id>.md`, а копии одной карточки сливаются по свежести `updated`
# (равенство — в пользу дерева) — та же семантика, что у сторожа
# (`dsh-kanban/lib/index.js`). Иначе исполнитель, у которого задача в работе
# внутри дерева, выглядел бы свободным и получил бы вторую.
#
# Карточки к выдаче берутся из `backlog` слитого снимка по возрастанию id (FIFO)
# и выдаются переходом `backlog → todo --owner <id>` через `bin/task-move.sh`:
# правила протокола остаются в одном месте. Если карточка живёт в рабочем дереве,
# команду выполняет копия скрипта из этого дерева — иначе `task-move.sh` основного
# чекаута карточку не найдёт.
#
# Коды возврата: 0 — ок (в том числе «пополнять нечего»); 1 — ошибка конфига или
# доски; 3 — выдать не удалось: backlog пуст, backlog исчерпан (выдали меньше,
# чем не хватало) или нет свободных исполнителей.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASKS_DIR="$ROOT/.kanban/tasks"
BOARD_FILE="$ROOT/.kanban/board.json"
WORKERS_FILE="$ROOT/.kanban/.workers.json"
ROLES_FILE="$ROOT/.kanban/.watcher-roles.json"
DEFAULT_MIN_TODO=1

usage() {
  cat <<'EOF'
Использование:
  bin/backlog-fill.sh [--dry-run] [--min N]

Выдаёт карточки из backlog в todo, пока в todo не наберётся минимум (minTodo из
.kanban/board.json, по умолчанию 1), закрепляя их за свободными исполнителями из
.kanban/.workers.json (fallback — worker из .kanban/.watcher-roles.json).

Занятость и кандидаты считаются по всем доскам проекта: основной чекаут и
рабочие деревья (из дерева берётся только одноимённая карточка). Карточка,
живущая в ветке задачи, выдаётся оттуда же — своей копией bin/task-move.sh.
Если backlog кончился раньше, чем набрался минимум, выдача честно пишет, сколько
выдано и сколько недобрали.

  --dry-run   показать план и ничего не менять
  --min N     минимум на этот запуск

Коды возврата: 0 — ок (включая «пополнять нечего»); 1 — ошибка конфига/доски;
3 — выдать не удалось (backlog пуст, backlog исчерпан или нет свободных
исполнителей). --dry-run возвращает те же коды, что и обычный запуск: по нему
видно, чем кончилось бы дело.
EOF
}

DRY_RUN=0
MIN_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --min)
      if (( $# < 2 )) || [[ -z "${2:-}" ]]; then
        echo "--min требует значения: --min N" >&2
        exit 2
      fi
      if [[ ! "$2" =~ ^[0-9]+$ ]]; then
        echo "--min: ожидается целое неотрицательное число (получено: $2)" >&2
        exit 2
      fi
      MIN_OVERRIDE="$2"; shift 2 ;;
    --min=*)
      MIN_OVERRIDE="${1#*=}"
      if [[ ! "$MIN_OVERRIDE" =~ ^[0-9]+$ ]]; then
        echo "--min: ожидается целое неотрицательное число (получено: $MIN_OVERRIDE)" >&2
        exit 2
      fi
      shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit 2 ;;
  esac
done

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

# Статус карточки в том же виде, в каком его понимает доска: регистр, пробелы и
# основные синонимы. Полный список синонимов живёт в `watcher-core.js`
# (`normalizeStatus`), но выдаче нужны только три статуса — очередь, бэклог и
# работа, — поэтому здесь разворачиваются синонимы именно для них: карточка со
# `status: wip` не должна выглядеть свободной.
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

die_config() {
  echo "$*" >&2
  exit 1
}

# Минимум карточек в todo: аргумент, board.json или значение по умолчанию.
read_min_todo() {
  local value="$1"
  if [[ -z "$value" ]]; then
    if [[ ! -f "$BOARD_FILE" ]]; then
      printf '%s' "$DEFAULT_MIN_TODO"
      return 0
    fi
    local body
    body="$(tr -d '[:space:]' < "$BOARD_FILE" 2>/dev/null || true)"
    case "$body" in
      \{*\}) ;;
      *) die_config "битый JSON в $BOARD_FILE: ожидался объект { \"minTodo\": <число> }" ;;
    esac
    value="$(printf '%s' "$body" | sed -n 's/.*"minTodo"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p')"
    if [[ -z "$value" ]]; then
      die_config "в $BOARD_FILE нет целого minTodo: ожидалось { \"minTodo\": <число> }"
    fi
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    die_config "минимум должен быть целым неотрицательным числом: $value"
  fi
  printf '%s' "$((10#$value))"
}

# Пул исполнителей: .workers.json, иначе единственный worker из .watcher-roles.json.
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
    # Собранный обратно массив должен совпасть с файлом: иначе в нём что-то
    # лишнее — нет запятой между строками, числа или посторонние символы.
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

# Идентификатор карточки: поле `id`, иначе имя файла.
card_id() {
  local id
  id="$(card_field "$1" id)"
  printf '%s' "${id:-$(basename "$1" .md)}"
}

# Карточка с front matter: файл начинается с `---`. Битые файлы (в дереве может
# лежать что угодно) в снимок не попадают — как и у сторожа, где такая карточка
# не разбирается и на доску не едет.
card_ok() {
  local first=""
  IFS= read -r first < "$1" || true
  [[ "${first%$'\r'}" == "---" ]]
}

# Карточки со всех досок проекта: `<из дерева 0|1>\t<путь>\t<id>\t<updated>`.
# Из дерева берётся только одноимённая карточка `<name>.md`: дерево ветвится от
# основной ветки и наследует чужие карточки, а они не его задачи (то же правило,
# что у сторожа и в клиентской половине плагина). Битый или пустой каталог
# дерева просто не даёт строк.
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
      # Живая карточка дерева — ровно та, что названа каталогом: файл с чужим `id`
      # внутри (порченая копия) не должен подменить чужую карточку — то же
      # правило, что `liveId` у сторожа (`dsh-kanban/lib/index.js`).
      [[ "$(card_id "$file")" == "$name" ]] || continue
      printf '1\t%s\t%s\t%s\n' "$file" "$(card_id "$file")" "$(card_field "$file" updated)"
    done
  done
}

# Чем двигать карточку: карточка рабочего дерева живёт в его ветке, и скрипт
# основного чекаута её не найдёт (`task-move.sh` смотрит в свой `.kanban/tasks`).
# У дерева своя копия скрипта — ею и выдаём.
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

# Снимок доски так, как его видит выдача: одна живая копия на карточку.
# Свежесть — `updated` (ISO-строки сравниваются лексикографически), при равенстве
# выигрывает копия из рабочего дерева: она живая, а копия в основном чекауте
# могла остаться от прошлого слияния. Правило то же, что у сторожа (`isNewer`).
build_snapshot() {
  SNAPSHOT_FILE="$(mktemp "${TMPDIR:-/tmp}/kanban-snapshot.XXXXXX")"
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

cleanup() {
  [[ -n "$SNAPSHOT_FILE" ]] && rm -f "$SNAPSHOT_FILE"
  # Свой статус уборки не важен: код возврата скрипта сохраняет on_exit.
  return 0
}

# EXIT-ловушка не должна затирать код возврата (см. #056): статус запоминается
# до уборки и возвращается после неё.
on_exit() {
  local code=$?
  cleanup || true
  exit "$code"
}

# Занят ли исполнитель: у него есть карточка в работе на любой доске проекта.
worker_busy() {
  local who="$1" id file from_tree
  while IFS=$'\t' read -r id file from_tree; do
    [[ "$(card_status "$file")" == "in-progress" ]] || continue
    [[ "$(card_field "$file" owner)" == "$who" ]] && return 0
  done < "$SNAPSHOT_FILE"
  return 1
}

# Сколько карточек в статусе — по снимку доски (все доски, одна копия на карточку).
count_status() {
  local want="$1" id file from_tree count=0
  while IFS=$'\t' read -r id file from_tree; do
    [[ "$(card_status "$file")" == "$want" ]] && count=$((count + 1))
  done < "$SNAPSHOT_FILE"
  printf '%s' "$count"
}

if [[ ! -d "$TASKS_DIR" ]]; then
  die_config "нет каталога карточек: $TASKS_DIR"
fi

SNAPSHOT_FILE=""
trap on_exit EXIT
build_snapshot

MIN="$(read_min_todo "$MIN_OVERRIDE")"
read_workers

todo_now="$(count_status todo)"
if (( todo_now >= MIN )); then
  echo "todo: $todo_now, минимум $MIN — пополнять нечего"
  exit 0
fi

need=$((MIN - todo_now))
assigned=0
why=""
taken=" "
ids=""
owners=""

# Один проход по слитому снимку в порядке возрастания id (FIFO): карточка-кандидат
# может жить в ветке задачи, поэтому смотрим не только основной чекаут. Снимок
# показывает живую копию: если main хранит устаревший `backlog`, а в дереве та же
# карточка уже `in-progress`, второй исполнитель её не получит.
issued=" "
while IFS=$'\t' read -r id file from_tree; do
  [[ -n "$id" ]] || continue
  (( assigned < need )) || break
  [[ "$(card_status "$file")" == "backlog" ]] || continue
  case "$issued" in *" $id "*) continue ;; esac

  owner=""
  for candidate in ${WORKERS[@]+"${WORKERS[@]}"}; do
    case "$taken" in *" $candidate "*) continue ;; esac
    if ! worker_busy "$candidate"; then
      owner="$candidate"
      break
    fi
  done
  if [[ -z "$owner" ]]; then
    why="нет свободных исполнителей"
    break
  fi

  if (( DRY_RUN == 1 )); then
    echo "выдал бы #$id → $owner"
  else
    if ! "$(mover_for "$file" "$from_tree")" "$id" todo --owner "$owner" >/dev/null 2>&1; then
      why="bin/task-move.sh отказал в выдаче #$id"
      break
    fi
    echo "выдано: #$id → $owner"
  fi

  taken="$taken$owner "
  issued="$issued$id "
  ids="$ids $id"
  owners="$owners $owner"
  assigned=$((assigned + 1))
done < "$SNAPSHOT_FILE"

# Честный итог: если выдали меньше, чем не хватало, то из-за исчерпанного
# backlog — важно, сколько именно выдали и сколько осталось недобрать.
if [[ -z "$why" ]] && (( assigned < need )); then
  if (( assigned == 0 )); then
    why="backlog пуст"
  else
    why="backlog исчерпан: выдано $assigned из $need, недобор $((need - assigned))"
  fi
fi

final_todo=$((todo_now + assigned))
if (( DRY_RUN == 1 )); then
  echo "план: todo $todo_now → $final_todo (минимум $MIN), выдано $assigned из $need нужных"
else
  echo "итого: todo $todo_now → $final_todo (минимум $MIN), выдано $assigned из $need нужных"
fi
if [[ -n "$why" ]]; then
  echo "остановка: $why"
fi

if (( assigned < need )); then
  exit 3
fi
exit 0
