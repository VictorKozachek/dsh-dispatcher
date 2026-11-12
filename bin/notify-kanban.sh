#!/usr/bin/env bash
# Уведомить оркестратора проекта dsh-kanban о найденном баге в кипер-логике
# (сессии, карточки, роли, сторож доски).
#
# Зачем: баги про сессии/карточки живут не в этом проекте, а в плагине
# dsh-kanban. Мы не правим чужую доску руками, а кладём наряд в её очередь
# недоставленных (`.kanban/.watcher-pending.json`) — сторож доски dsh-kanban
# повторит его при следующем старте профиля или событии доски, ровно тем же
# способом, каким доставляет обычные наряды.
#
# Использование:
#   bin/notify-kanban.sh "текст наряда"
#   bin/notify-kanban.sh --issue 4 "текст"     # упомянуть номер issue в тексте
#   bin/notify-kanban.sh --dry-run "текст"
#
# Требует записи вне рабочей директории (чужая доска) — на песочнице это
# danger-full-access; скрипт прямо об этом говорит, а не падает молча.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KANBAN="${KANBAN_HOME:-$HOME/projects/dsh-kanban}"
PENDING="$KANBAN/.kanban/.watcher-pending.json"
ROLES="$KANBAN/.kanban/.watcher-roles.json"

ISSUE=""
DRY=0
TEXT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) ISSUE="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) TEXT="$1"; shift ;;
  esac
done

if [[ -z "$TEXT" ]]; then
  echo "нужен текст наряда: bin/notify-kanban.sh \"что случилось\"" >&2
  exit 2
fi
if [[ ! -f "$PENDING" ]]; then
  echo "нет файла очереди: $PENDING (доска dsh-kanban не найдена)" >&2
  exit 3
fi

SESSION="$(python3 - "$ROLES" <<'PY'
import json, sys, pathlib
try:
    roles = json.loads(pathlib.Path(sys.argv[1]).read_text())
except Exception:
    roles = {}
print(roles.get("dispatcher") or roles.get("worker") or "")
PY
)"
if [[ -z "$SESSION" ]]; then
  echo "в $ROLES нет dispatcher/worker — некого уведомлять" >&2
  exit 4
fi

if [[ -n "$ISSUE" ]]; then
  TEXT="$TEXT (issue #$ISSUE: https://github.com/VictorKozachek/dsh-kanban/issues/$ISSUE)"
fi

if [[ "$DRY" == "1" ]]; then
  echo "кому: $SESSION"
  echo "куда: $PENDING"
  echo "текст: $TEXT"
  exit 0
fi

python3 - "$PENDING" "$SESSION" "$TEXT" <<'PY'
import json, sys, pathlib, time, hashlib

pending_path, session, text = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(pending_path)
try:
    pending = json.loads(p.read_text() or "{}")
except Exception:
    pending = {}

# Ключ стабилен для одного и того же текста: повторный вызов не плодит дубли.
key = "notify:" + hashlib.sha256((session + text).encode()).hexdigest()[:16]
pending[key] = {
    "cardId": None,
    "status": "notify",
    "sessionId": session,
    "text": text,
    "worktree": "",
    "at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
}
p.write_text(json.dumps(pending, ensure_ascii=False, indent=1) + "\n")
print(f"наряд поставлен в очередь: {key} → {session}")
PY
