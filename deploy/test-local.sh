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

start() {
  RELAY_AGENT_TOKEN=test-agent-token \
  RELAY_BIND="127.0.0.1:$PORT" \
  RELAY_DATABASE_URL="sqlite:file:$WORK/data/relay.db?mode=rwc" \
    "$RELAY_BIN" >"$WORK/relay.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do
    if curl -fsS -H 'X-Relay-Version: 1' "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  echo "test-local: релей не поднялся" >&2; cat "$WORK/relay.log" >&2; exit 1
}
stop() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""; }

export RELAY_BASE_URL="http://127.0.0.1:$PORT"
export RELAY_AGENT_TOKEN=test-agent-token
export RELAY_DB_FILE="$WORK/data/relay.db"
export BACKUP_DIR="$WORK/backups"

mkdir -p "$WORK/data"
start
"$DEPLOY_DIR/smoke.sh"
"$DEPLOY_DIR/backup.sh"
ARCHIVE=$(ls "$BACKUP_DIR"/relay-*.tar.gz | head -1)
[ -n "$ARCHIVE" ] || { echo "test-local: бэкап не создан" >&2; exit 1; }

# Битый архив должен быть отвергнут (sha256).
cp "$ARCHIVE" "$WORK/broken.tar.gz"
cp "$ARCHIVE.sha256" "$WORK/broken.tar.gz.sha256"
printf 'x' | dd of="$WORK/broken.tar.gz" bs=1 seek=100 conv=notrunc 2>/dev/null
if "$DEPLOY_DIR/restore.sh" "$WORK/broken.tar.gz" >/dev/null 2>&1; then
  echo "test-local: битый архив не был отвергнут" >&2; exit 1
fi

stop
mv "$WORK/data/relay.db" "$WORK/data/relay.db.before-restore"
"$DEPLOY_DIR/restore.sh" "$ARCHIVE"
start
DEVICES=$(curl -fsS -H 'X-Relay-Version: 1' "$RELAY_BASE_URL/healthz" | sed -n 's/.*"devices":\([0-9]*\).*/\1/p')
[ "${DEVICES:-0}" -ge 1 ] || { echo "test-local: после restore в базе нет устройств" >&2; exit 1; }

echo "test-local: OK — smoke, backup, отказ битому архиву, restore и healthz"
