#!/usr/bin/env bash
#
# Расход токенов сессии: снимок из кэша проекций DSH.
#
#   bin/task-usage.sh [<session-id>] [--field total|input|output|cache] [--json]
#
# По умолчанию берётся $DSH_SESSION_ID, печатается одно число — сумма четырёх
# счётчиков (uncached input + output + cache read + cache write).
#
# Источник — файл, который хост обновляет живьём:
#   ${DSH_HOME:-$HOME/.dsh}/storages/session_projcache/sessions/<session-id>.json
#   → record.rows.tokenUsage.val.totals
# (в прежних версиях — record.tokenUsage.val.totals; поддерживаются обе формы).
#
# Если файла или счётчиков ещё нет (сессия только началась), скрипт печатает
# пусто и выходит с кодом 1 — вызывающий не запишет в карточку мусор.
#
set -euo pipefail

SESSION="${DSH_SESSION_ID:-}"
FIELD="total"
JSON=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --field) FIELD="${2:?--field требует значения}"; shift 2 ;;
    --field=*) FIELD="${1#*=}"; shift ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '3,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'; exit 0 ;;
    -*) echo "неизвестная опция: $1" >&2; exit 2 ;;
    *) SESSION="$1"; shift ;;
  esac
done

if [[ -z "$SESSION" ]]; then
  echo "нужен id сессии: bin/task-usage.sh <session-id> (или экспортированный DSH_SESSION_ID)" >&2
  exit 2
fi

case "$FIELD" in
  total|input|output|cache) ;;
  *) echo "неизвестное поле: $FIELD (total | input | output | cache)" >&2; exit 2 ;;
esac

HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
CACHE="$HOME_DIR/storages/session_projcache/sessions/$SESSION.json"

if [[ ! -f "$CACHE" ]]; then
  echo "нет кэша проекций для сессии $SESSION: $CACHE" >&2
  exit 1
fi

python3 - "$CACHE" "$FIELD" "$JSON" <<'PY'
import json
import sys

path, field, as_json = sys.argv[1], sys.argv[2], sys.argv[3] == "1"

try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, ValueError):
    sys.exit(1)

record = data.get("record") or {}
# Новые версии кладут проекции в record.rows, старые — прямо в record.
unit = (record.get("rows") or {}).get("tokenUsage") or record.get("tokenUsage") or {}
totals = (unit.get("val") or {}).get("totals") or {}
if not totals:
    sys.exit(1)

buckets = {
    "input": int(totals.get("uncachedInputTokens") or 0),
    "output": int(totals.get("outputTokens") or 0),
    "cacheRead": int(totals.get("cacheReadTokens") or 0),
    "cacheWrite": int(totals.get("cacheWriteTokens") or 0),
}
total = sum(buckets.values())

if as_json:
    print(json.dumps({**buckets, "total": total, "seq": unit.get("seq")}, ensure_ascii=False))
elif field == "total":
    print(total)
elif field == "cache":
    print(buckets["cacheRead"] + buckets["cacheWrite"])
else:
    print(buckets[field])
PY
