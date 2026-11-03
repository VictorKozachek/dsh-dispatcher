#!/usr/bin/env bash
#
# Перевести карточку задачи в другой статус и обновить её поля.
#
# Использование:
#   bin/task-move.sh <id> <status> [--owner ID] [--role РОЛЬ] [--note ТЕКСТ]
#                                  [--tokens auto|N] [--branch ВЕТКА]
#                                  [--worktree ПУТЬ] [--no-commit] [--force]
#
# Статусы: backlog | todo | in-progress | in-review | testing | ready | merged | blocked
#
# Разрешённые переходы (протокол — в AGENTS.md):
#   backlog     → todo | blocked            асайн (с --owner) или «упёрлась до выдачи»
#   todo        → in-progress               исполнитель берёт задачу
#   todo        → backlog                   возврат в очередь: задача ещё не выдана
#   in-progress → in-review                 работа сдана на код-ревью
#   in-review   → in-progress | testing     ревьювер вернул или принял
#   testing     → ready | in-progress       тестировщик принял или вернул
#   ready       → in-progress               оркестратор вернул (конфликт);
#                                            merged — только bin/task-commit.sh
#   backlog|todo|in-progress|in-review|testing|ready → blocked  нужен человек
#   blocked     → in-progress               развязка получена
#   любой       → тот же статус             повторная запись полей
# Недопустимый переход отвергается; --force выполняет его молча.
#
# `backlog` — лог задач: у карточки там нет владельца и роли, поэтому переход
# `backlog → todo` требует `--owner` (это асайн), а прыжок `backlog → in-progress`
# запрещён: сначала выдача в `todo`, чтобы исполнитель получил наряд.
#
# Карточка коммитится в текущую ветку (если это git-репозиторий), чтобы смена
# статуса уехала в слияние вместе с задачей. --no-commit отключает это.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASKS_DIR="$ROOT/.kanban/tasks"
STATUSES=(backlog todo in-progress in-review testing ready merged blocked)

# Какие переходы разрешает протокол (см. AGENTS.md). Повторная запись того же
# статуса разрешена всегда: так обновляют owner и note, не двигая карточку.
allowed_targets() {
  case "$1" in
    "" | todo) printf '%s' "in-progress, backlog, blocked" ;;
    backlog) printf '%s' "todo, blocked" ;;
    in-progress) printf '%s' "in-review, blocked" ;;
    in-review) printf '%s' "in-progress, testing, blocked" ;;
    testing) printf '%s' "ready, in-progress, blocked" ;;
    ready) printf '%s' "in-progress, blocked" ;;
    merged) printf '%s' "—" ;;
    blocked) printf '%s' "in-progress" ;;
    *) printf '%s' "in-progress, in-review, testing, ready, merged, blocked" ;;
  esac
}

is_allowed_transition() {
  local from="$1" to="$2" list
  [[ "$from" == "$to" ]] && return 0
  list="$(allowed_targets "$from")"
  case ",${list//, /,}," in
    *",$to,"*) return 0 ;;
    *) return 1 ;;
  esac
}

usage() {
  # Весь заголовочный комментарий, кроме shebang и строки `set -euo pipefail`.
  sed -n '3,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
}

# `--help` отвечает с нулевым кодом и без обязательных аргументов.
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi

if [[ $# -lt 2 ]]; then usage >&2; exit 2; fi

id="${1#\#}"; shift
status="$1"; shift

case " ${STATUSES[*]} " in
  *" $status "*) ;;
  *) echo "неизвестный статус: $status (допустимо: ${STATUSES[*]})" >&2; exit 2 ;;
esac

OWNER=""; ROLE=""; NOTE=""; TOKENS=""; BRANCH=""; WORKTREE=""; DO_COMMIT=1; FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="${2:?}"; shift 2 ;;
    --owner=*) OWNER="${1#*=}"; shift ;;
    --role) ROLE="${2:?}"; shift 2 ;;
    --role=*) ROLE="${1#*=}"; shift ;;
    --tokens) TOKENS="${2:?}"; shift 2 ;;
    --tokens=*) TOKENS="${1#*=}"; shift ;;
    --note) NOTE="${2:?}"; shift 2 ;;
    --note=*) NOTE="${1#*=}"; shift ;;
    --branch) BRANCH="${2:?}"; shift 2 ;;
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --worktree) WORKTREE="${2:?}"; shift 2 ;;
    --worktree=*) WORKTREE="${1#*=}"; shift ;;
    --no-commit) DO_COMMIT=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "неизвестная опция: $1" >&2; exit 2 ;;
  esac
done

card="$TASKS_DIR/$id.md"
if [[ ! -f "$card" ]]; then
  echo "карточка не найдена: $card" >&2
  exit 1
fi

# Текущий статус: только первый блок front matter между `---`.
current_status() {
  awk 'NR == 1 && $0 == "---" { infm = 1; next }
       infm == 1 && $0 == "---" { exit }
       infm == 1 && /^status:/ {
         sub(/^status:[[:space:]]*/, "");
         gsub(/^"|"$/, "");
         sub(/[[:space:]]+$/, "");
         print;
         exit
       }' "$card"
}

current="$(current_status)"

# Значение поля front matter (первый блок между `---`).
field_of() {
  awk -v key="$1" '
    NR == 1 && $0 == "---" { infm = 1; next }
    infm == 1 && $0 == "---" { exit }
    infm == 1 && index($0, key ":") == 1 {
      sub("^" key ":[[:space:]]*", "");
      gsub(/^"|"$/, "");
      sub(/[[:space:]]+$/, "");
      # Снять экранирование, которое добавляет yaml_value: \" → ", \\ → \.
      gsub(/\\"/, "\"");
      gsub(/\\\\/, "\\");
      print;
      exit
    }' "$card" | sed -e "s/^[[:space:]']*//" -e "s/[[:space:]']*\$//"
}

# merged ставит только bin/task-commit.sh: он мержит ветку и собирает сообщение
# коммита по правилу проекта. Здесь ловим попытку проскочить мимо него.
if [[ "$status" == "merged" && "$FORCE" == 0 && "$current" != "merged" ]]; then
  echo "статус merged ставит только bin/task-commit.sh: сейчас карточка в «${current:-<без статуса>}», а слияние делается из ready" >&2
  echo "он мержит ветку задачи с сообщением по правилу [{SHORT_BRANCH_NAME}] Message; ручной обход: --force" >&2
  echo "перейти можно так: bin/task-commit.sh $id   (ручной обход: --force)" >&2
  exit 3
fi

# Сначала проверяем сам переход и только потом — кто его делает: иначе
# «merged → in-progress» без имени исполнителя отвечало бы «не знаю, кто берёт»
# вместо «недопустимый переход».
if (( FORCE == 0 )) && ! is_allowed_transition "$current" "$status"; then
  echo "недопустимый переход: ${current:-<без статуса>} → $status" >&2
  echo "разрешено из «${current:-<без статуса>}»: $(allowed_targets "$current")" >&2
  echo "протокол переходов — в AGENTS.md; осознанный обход: --force" >&2
  exit 3
fi

# Асайн — отдельное действие: из backlog задачу выдают в todo сразу с владельцем.
# Без --owner карточка просто вернулась бы в очередь без хозяина, и исполнитель
# не получил бы наряда — поэтому такой переход отвергаем, а не делаем молча.
if (( FORCE == 0 )) && [[ "$current" == "backlog" && "$status" == "todo" && -z "$OWNER" ]]; then
  echo "переход backlog → todo — это асайн: передайте --owner <session-id> исполнителя" >&2
  echo "задача $id осталась в backlog; протокол выдачи — AGENTS.md, пункт 6" >&2
  exit 3
fi

# Задачу выдаёт оркестратор: в работу берут только закреплённое за собой.
# Незакреплённую карточку не берут самовольно, чужую — тем более: иначе двое
# сделают одну работу. Осознанный обход — --force.
#
# Проверяем владельца всюду, где карточку в работу возвращает САМ исполнитель:
# из очереди (todo или пустой статус) и из блокировки (blocked — «нужен человек»,
# снимает её исполнитель). Возвраты из ревью, тестов и готового к слиянию
# (in-review/testing/ready) делает другая роль — их guard не касается, иначе
# ревьювер не смог бы вернуть карточку без --force. Карточка в backlog владельца
# не имеет вовсе, а получает его асайном — этот guard на неё не опирается.
#
# Без этого правила карточку уводили в работу в два шага: todo → blocked →
# in-progress — блокировку ставит кто угодно, а снятие проверок не имело.
guard_owner=1
case "$current" in
  in-review|testing|ready) guard_owner=0 ;;
esac
holder="$(field_of owner)"
caller="${OWNER:-${DSH_SESSION_ID:-}}"

# Под проверкой не только взятие из очереди и разблокировка, но и карточка,
# которая уже в работе, а владельца в ней нет: иначе её допишет себе любой, кто
# её увидел (владелец пропадает через --force или ручную правку).
if (( FORCE == 0 && guard_owner == 1 )) && [[ "$status" == "in-progress" ]] &&
   { [[ "$current" != "in-progress" ]] || [[ -z "$holder" ]]; }; then
  if [[ -z "$caller" ]]; then
    echo "не знаю, кто берёт задачу $id: передайте --owner \"\$DSH_SESSION_ID\"" >&2
    exit 3
  fi
  if [[ -z "$holder" ]]; then
    # Готовую команду не печатаем: она же была и готовым обходом правила.
    echo "задача $id не закреплена: выдаёт её оркестратор — попросите его закрепить" >&2
    echo "карточку за вами; протокол выдачи — AGENTS.md, пункт 6." >&2
    echo "осознанный обход: --force" >&2
    exit 3
  fi
  if [[ "$holder" != "$caller" ]]; then
    echo "задача $id закреплена за $holder: забирать её может только он (или --force)" >&2
    exit 3
  fi
fi

# Смена владельца чужой карточки — только осознанно: иначе правило выдачи
# обходится в два шага (сначала переписать owner на себя, потом взять задачу).
if (( FORCE == 0 )) && [[ -n "$OWNER" ]]; then
  holder="$(field_of owner)"
  if [[ -n "$holder" && "$holder" != "$OWNER" ]]; then
    echo "карточка $id закреплена за $holder: владелец меняется только им самим или осознанно (--force)" >&2
    exit 3
  fi
fi

# Значение для YAML: простое — как есть, иначе в кавычках.
yaml_value() {
  local value="$1"
  if [[ "$value" =~ ^[A-Za-z0-9_./@-]+$ ]]; then
    printf '%s' "$value"
  else
    printf '"%s"' "$(printf '%s' "$value" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  fi
}

stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Права файла в виде числа: mktemp создаёт 0600, и без этого карточка
# «теряет» права при каждой правке (macOS и Linux сообщают их по-разному).
file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null || echo 644
}

# Записать/заменить ключ в YAML-front-matter, не трогая остальной файл.
# Значение передаётся через окружение, а не `awk -v`: тот разбирает
# escape-последовательности и падает на переводе строки.
set_field() {
  local key="$1" value="$2" tmp mode
  tmp="$(mktemp "${TMPDIR:-/tmp}/kanban.XXXXXX")"
  mode="$(file_mode "$card")"
  KANBAN_KEY="$key" KANBAN_VALUE="$value" awk '
    BEGIN { key = ENVIRON["KANBAN_KEY"]; val = ENVIRON["KANBAN_VALUE"] }
    NR == 1 && $0 == "---" { infm = 1; print; next }
    infm == 1 && $0 == "---" {
      if (!done) { if (!seen) print key ": " val; done = 1 }
      infm = 0; print; next
    }
    infm == 1 {
      if (index($0, key ":") == 1) { if (!done) { print key ": " val; done = 1; seen = 1 } next }
      print; next
    }
    { print }
  ' "$card" > "$tmp"
  chmod "$mode" "$tmp" 2>/dev/null || true
  mv "$tmp" "$card"
}

set_field status "$status"
set_field updated "$stamp"
[[ -n "$OWNER" ]] && set_field owner "$(yaml_value "$OWNER")"
[[ -n "$ROLE" ]] && set_field role "$(yaml_value "$ROLE")"

# В backlog карточка лежит без владельца и роли: это лог нарезанных задач, а не
# чья-то работа. Снимаем оба поля и здесь, а не только при возврате в очередь:
# так карточка, заведённая с --owner или переведённая из todo, не выглядит
# закреплённой, пока оркестратор не выдал её в todo.
if [[ "$status" == "backlog" ]]; then
  set_field owner '""'
  set_field role '""'
fi

# Расход токенов: снимок кумулятивного счётчика сессии на момент передачи.
# Поле на роль, чтобы по карточке было видно, кто сколько съел.
if [[ -n "$TOKENS" ]]; then
  if [[ -z "$ROLE" ]]; then
    echo "--tokens требует --role: расход пишется в поле tokens_<роль>" >&2
    exit 2
  fi
  if [[ "$TOKENS" == "auto" ]]; then
    TOKENS="$("$ROOT/bin/task-usage.sh" 2>/dev/null || true)"
    if [[ -z "$TOKENS" ]]; then
      echo "предупреждение: расход токенов не прочитан (нет кэша проекций) — поле не пишу" >&2
    fi
  fi
  if [[ -n "$TOKENS" ]]; then
    set_field "tokens_$ROLE" "$(yaml_value "$TOKENS")"
    total="$(awk '
      NR == 1 && $0 == "---" { infm = 1; next }
      infm == 1 && $0 == "---" { exit }
      infm == 1 && /^tokens_/ {
        value = $0; sub(/^[^:]*:[[:space:]]*/, "", value); gsub(/"/, "", value);
        if (value ~ /^[0-9]+$/) sum += value
      }
      END { print sum + 0 }' "$card")"
    set_field tokens "$total"
  fi
fi

# Возврат карточки в работу: она снова у своего исполнителя. Владельца не
# трогаем — `owner` и есть исполнитель задачи, он ставится при взятии из очереди;
# а `role` показывает, кто держит карточку сейчас.
if [[ "$status" == "in-progress" && -n "$current" && "$current" != "in-progress" && "$current" != "todo" ]]; then
  set_field role worker
fi

# Метка «с какого времени карточка у текущей роли»: по ней видно застой.
case "$status" in
  in-progress|in-review|testing|blocked) set_field since "$stamp" ;;
  *) set_field since "" ;;
esac
[[ -n "$BRANCH" ]] && set_field branch "$(yaml_value "$BRANCH")"
[[ -n "$WORKTREE" ]] && set_field worktree "$(yaml_value "$WORKTREE")"
# В front matter заметка обязана быть однострочной (доска показывает её на
# карточке), поэтому переводы строк схлопываем, а полный текст пишем в тело.
if [[ -n "$NOTE" ]]; then
  note_inline="$(printf '%s' "$NOTE" | tr '\n' ' ' | sed -e 's/[[:space:]]\{1,\}/ /g' -e 's/^ //' -e 's/ $//')"
  set_field note "$(yaml_value "$note_inline")"

  printf '\n- %s [%s]\n' "$stamp" "$status" >> "$card"
  printf '%s\n' "$NOTE" | sed 's/^/  /' >> "$card"
fi

# Смена статуса должна уехать в ветку вместе с задачей: иначе слияние принесёт
# в основной чекаут карточку со старым статусом. Коммитим ТОЛЬКО карточку.
if (( DO_COMMIT == 1 )) && git -C "$ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  relative=".kanban/tasks/$id.md"
  if git -C "$ROOT" add -- "$relative" >/dev/null 2>&1 &&
     git -C "$ROOT" commit -q -m "kanban($id): $status" -- "$relative" >/dev/null 2>&1; then
    echo "задача $id → $status ($card), карточка закоммичена"
    exit 0
  fi
  echo "предупреждение: карточка изменена, но не закоммичена (нет git identity или нечего коммитить)" >&2
  echo "             закоммитьте вручную: git add $relative && git commit -m 'kanban($id): $status'" >&2
fi

echo "задача $id → $status ($card)"
