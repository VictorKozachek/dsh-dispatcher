#!/usr/bin/env bash
#
# Завести спецификацию: `.kanban/specs/<NNN>.md` по пустому шаблону.
#
#   bin/spec-new.sh "Название спеки"
#
# Номер сквозной, как у задач, но файлы в репозитории лежат со слагом
# (`.kanban/specs/001-backlog.md`), поэтому номер — это числовой ПРЕФИКС имени:
# `001.md` и `001-backlog.md` одинаково занимают 001. Новый файл получает первый
# свободный номер: `<NNN>.md` рядом с существующими. Спека — основание для
# нарезки: оркестратор читает её и заводит карточки в `backlog`
# (`bin/task-new.sh "..." --backlog --no-worktree --spec NNN`), а карточка
# ссылается на спеку полем `spec`.
#
# Скрипт только пишет файл и не коммитит его: это документ проекта, коммит
# делает тот, кто ведёт работу (оркестратор в основном чекауте).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPECS_DIR="$ROOT/.kanban/specs"

usage() {
  cat <<'EOF'
Использование:
  bin/spec-new.sh "Название спеки"

Заводит .kanban/specs/<NNN>.md со следующим свободным номером и пустым шаблоном
(статус, «Зачем», «Требования», «Вне скоупа»). Номер — числовой префикс имени:
001.md и 001-backlog.md одинаково занимают 001. Файл не коммитится.
EOF
}

TITLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -*) echo "неизвестная опция: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -z "$TITLE" ]]; then TITLE="$1"; else echo "лишний аргумент: $1" >&2; exit 2; fi
      shift ;;
  esac
done

if [[ -z "$TITLE" ]]; then
  echo "нужно название спеки" >&2
  usage >&2
  exit 2
fi

# Следующий свободный номер: номер занимает ЛЮБОЙ файл спеки с числовым
# префиксом — `001.md` и `001-backlog.md` одинаково занимают 001. Смотрим именно
# префикс, а не имя целиком: в репозитории спеки лежат с человекочитаемым слагом,
# и подсчёт «только из цифр» выдавал второй файл с занятым номером.
number_of() {
  local name="${1##*/}"
  name="${name%%[!0-9]*}"
  printf '%s' "$name"
}

taken() {
  local want="$1" file number
  for file in "$SPECS_DIR"/*.md; do
    [[ -e "$file" ]] || continue
    number="$(number_of "$file")"
    [[ -n "$number" ]] || continue
    (( 10#$number == want )) && return 0
  done
  return 1
}

next=1
if [[ -d "$SPECS_DIR" ]]; then
  # Первый свободный: дыры от удалённых/переименованных спек тоже годятся.
  while taken "$next"; do next=$((next + 1)); done
fi

id="$(printf '%03d' "$next")"
card="$SPECS_DIR/$id.md"
if [[ -e "$card" ]]; then
  echo "файл $card уже существует" >&2
  exit 1
fi

mkdir -p "$SPECS_DIR"
{
  printf '# Спека %s: %s\n\n' "$id" "$TITLE"
  printf 'Статус: черновик.\n\n'
  printf '## Зачем\n\n'
  printf 'Зачем это нужно и что изменится, когда появится.\n\n'
  printf '## Требования\n\n'
  printf -- '- [ ] \n\n'
  printf '## Вне скоупа\n\n'
  printf -- '- \n'
} > "$card"

echo "спека $id: $card"
echo "дальше: нарезать на карточки — bin/task-new.sh \"Название\" --backlog --no-worktree --spec $id"
