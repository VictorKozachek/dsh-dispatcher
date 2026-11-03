#!/usr/bin/env bash
# Локальная проверка deploy-скриптов без Docker: поднимает собранный релей на
# случайном порту и прогоняет smoke + backup + restore (+ отказ битому архиву).
#
#   cd relay && cargo build --release
#   RELAY_BIN=$PWD/relay/target/release/dsh-relay deploy/test-local.sh
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd "$DEPLOY_DIR/.." && pwd)
RELAY_BIN=${RELAY_BIN:-$REPO_DIR/relay/target/release/dsh-relay}
[ -x "$RELAY_BIN" ] || { echo "test-local: нет бинаря $RELAY_BIN (соберите: cd relay && cargo build --release)" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "test-local: нужен $1" >&2; exit 1; }; }
need curl; need python3; need sqlite3; need tar

PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
WORK=$(mktemp -d "${TMPDIR:-/tmp}/dsh-deploy-test.XXXXXX")
PID=""
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

start() { # start [ALLOWLIST]: пустая строка = allowlist не задан
  local allowlist=${1-__unset__}
  if [ "$allowlist" = "__unset__" ]; then
    unset RELAY_ALLOWED_DEVICES
  else
    export RELAY_ALLOWED_DEVICES="$allowlist"
  fi
  RELAY_AGENT_TOKEN=test-agent-token \
  RELAY_BIND="127.0.0.1:$PORT" \
  RELAY_DATABASE_URL="sqlite:file:$WORK/data/relay.db?mode=rwc" \
    "$RELAY_BIN" >"$WORK/relay.log" 2>&1 &
  PID=$!
  disown "$PID" 2>/dev/null || true
  for _ in $(seq 1 50); do
    if curl -fsS -H 'X-Relay-Version: 1' "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  echo "test-local: релей не поднялся" >&2; cat "$WORK/relay.log" >&2; exit 1
}
stop() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""; }

json() { python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {"d": data}))' "$WORK/resp.json" "$1"; }
api() { # api METHOD PATH AUTH BODY -> status, ответ в $WORK/resp.json
  local method=$1 path=$2 auth=$3 body=${4:-}
  local args=(-sS -o "$WORK/resp.json" -w '%{http_code}' -X "$method" -H 'X-Relay-Version: 1' -H 'content-type: application/json')
  [ -n "$auth" ] && args+=(-H "authorization: Bearer $auth")
  [ -n "$body" ] && args+=(--data "$body")
  curl "${args[@]}" "$RELAY_BASE_URL$path"
}
register_device() {
  local public_key
  public_key=$(python3 -c 'import base64,os;print(base64.b64encode(os.urandom(32)).decode())')
  local status
  status=$(api POST /v1/devices "" "{\"platform\":\"ios\",\"publicKey\":\"$public_key\"}")
  case "$status" in 200|201) ;; *) echo "test-local: device $status" >&2; exit 1;; esac
  json 'd["deviceId"]'
}
new_code() {
  local status
  status=$(api POST /v1/pairing "$RELAY_AGENT_TOKEN" "")
  [ "$status" = "201" ] || { echo "test-local: pairing $status" >&2; exit 1; }
  json 'd["pairCode"]'
}
try_pair() { # try_pair code deviceId -> status
  api POST /v1/pair "" "{\"pairCode\":\"$1\",\"deviceId\":\"$2\"}"
}

export RELAY_BASE_URL="http://127.0.0.1:$PORT"
export RELAY_AGENT_TOKEN=test-agent-token
export RELAY_DB_FILE="$WORK/data/relay.db"
export BACKUP_DIR="$WORK/backups"

mkdir -p "$WORK/data"
# Пустая строка allowlist (как долгое время задавал compose) не должна ничего
# запрещать: иначе первая же привязка в Docker-пути получает 403.
start ""
"$DEPLOY_DIR/smoke.sh"

# Непустой allowlist: своё устройство привязывается, чужое — 403.
ALLOWED_DEVICE=$(register_device)
stop
start "$ALLOWED_DEVICE"
CODE=$(new_code)
STATUS=$(try_pair "$CODE" "$ALLOWED_DEVICE")
[ "$STATUS" = "200" ] || { echo "test-local: allowlist не пустил своё устройство ($STATUS)" >&2; exit 1; }
FOREIGN_DEVICE=$(register_device)
CODE=$(new_code)
STATUS=$(try_pair "$CODE" "$FOREIGN_DEVICE")
[ "$STATUS" = "403" ] || { echo "test-local: чужое устройство получило $STATUS вместо 403" >&2; exit 1; }
stop
start
"$DEPLOY_DIR/backup.sh"
ARCHIVE=$(ls "$BACKUP_DIR"/relay-*.tar.gz | head -1)
[ -n "$ARCHIVE" ] || { echo "test-local: бэкап не создан" >&2; exit 1; }

# Переименованный архив с .sha256 от старого пути должен восстанавливаться:
# путь в файле игнорируется, сверяется только хеш.
cp "$ARCHIVE" "$WORK/renamed.tar.gz"
cp "$ARCHIVE.sha256" "$WORK/renamed.tar.gz.sha256"
"$DEPLOY_DIR/restore.sh" "$WORK/renamed.tar.gz" >/dev/null || { echo "test-local: переименованный архив не восстановился" >&2; exit 1; }

# Битый архив должен быть отвергнут (sha256).
cp "$ARCHIVE" "$WORK/broken.tar.gz"
cp "$ARCHIVE.sha256" "$WORK/broken.tar.gz.sha256"
printf 'x' | dd of="$WORK/broken.tar.gz" bs=1 seek=100 conv=notrunc 2>/dev/null
if "$DEPLOY_DIR/restore.sh" "$WORK/broken.tar.gz" >/dev/null 2>&1; then
  echo "test-local: битый архив не был отвергнут" >&2; exit 1
fi

# Подмена архива при «живом» .sha256 от другого бэкапа: восстановление обязано
# отказать, а не проверять старый файл по пути.
"$DEPLOY_DIR/smoke.sh" >/dev/null
"$DEPLOY_DIR/backup.sh" >/dev/null
SECOND=$(ls -t "$BACKUP_DIR"/relay-*.tar.gz | head -1)
cp "$SECOND" "$WORK/substituted.tar.gz"
cp "$ARCHIVE.sha256" "$WORK/substituted.tar.gz.sha256"
if "$DEPLOY_DIR/restore.sh" "$WORK/substituted.tar.gz" >/dev/null 2>&1; then
  echo "test-local: подменённый архив не был отвергнут" >&2; exit 1
fi

stop
mv "$WORK/data/relay.db" "$WORK/data/relay.db.before-restore"
"$DEPLOY_DIR/restore.sh" "$ARCHIVE"
start
DEVICES=$(curl -fsS -H 'X-Relay-Version: 1' "$RELAY_BASE_URL/healthz" | sed -n 's/.*"devices":\([0-9]*\).*/\1/p')
[ "${DEVICES:-0}" -ge 1 ] || { echo "test-local: после restore в базе нет устройств" >&2; exit 1; }

echo "test-local: OK — smoke, allowlist (пустой/непустой), backup, переименование и подмена архива, restore и healthz"
