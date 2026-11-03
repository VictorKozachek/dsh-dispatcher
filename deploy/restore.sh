#!/usr/bin/env bash
# Восстановление релея из бэкапа deploy/backup.sh.
#
# Использование:
#   deploy/restore.sh deploy/backups/relay-20261103T031700Z.tar.gz
#   RELAY_DB_FILE=./data/relay.db deploy/restore.sh <архив>   # локальный режим
#
# Проверяет sha256 архива (если есть .sha256), целостность базы
# (PRAGMA integrity_check) и делает резервную копию текущей базы перед заменой.
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.yml}
RELAY_VOLUME=${RELAY_VOLUME:-dsh-relay_relay_data}

[ $# -eq 1 ] || { echo "использование: $0 <архив.tar.gz>" >&2; exit 2; }
ARCHIVE=$1
[ -f "$ARCHIVE" ] || { echo "restore: нет архива $ARCHIVE" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "restore: нужен $1" >&2; exit 1; }; }
need tar
need sqlite3

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dsh-restore.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

if [ -f "$ARCHIVE.sha256" ]; then
  (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
else
  echo "restore: предупреждение — нет $ARCHIVE.sha256, проверяю только базу" >&2
fi

tar -xzf "$ARCHIVE" -C "$WORK_DIR"
DB_RESTORED=$WORK_DIR/relay.db
[ -s "$DB_RESTORED" ] || { echo "restore: в архиве нет relay.db" >&2; exit 1; }
sqlite3 "$DB_RESTORED" 'PRAGMA integrity_check;' | grep -qx 'ok' || {
  echo "restore: база из архива повреждена (integrity_check)" >&2; exit 1;
}
if [ -f "$WORK_DIR/manifest.json" ]; then
  EXPECTED=$(sed -n 's/.*"sha256": "\([^"]*\)".*/\1/p' "$WORK_DIR/manifest.json")
  ACTUAL=$(sha256sum "$DB_RESTORED" | cut -d' ' -f1)
  [ -z "$EXPECTED" ] || [ "$EXPECTED" = "$ACTUAL" ] || {
    echo "restore: sha256 базы не совпал с manifest" >&2; exit 1;
  }
  echo "restore: manifest ok (создан $(sed -n 's/.*"created_at": "\([^"]*\)".*/\1/p' "$WORK_DIR/manifest.json"))"
fi

if [ -n "${RELAY_DB_FILE:-}" ]; then
  echo "restore: локальный режим ($RELAY_DB_FILE)"
  mkdir -p "$(dirname "$RELAY_DB_FILE")"
  if [ -f "$RELAY_DB_FILE" ]; then
    cp "$RELAY_DB_FILE" "$RELAY_DB_FILE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    echo "restore: текущая база сохранена рядом (.bak-*)"
  fi
  cp "$DB_RESTORED" "$RELAY_DB_FILE"
else
  need docker
  echo "restore: docker compose ($COMPOSE_FILE)"
  docker compose -f "$COMPOSE_FILE" stop relay || true
  docker run --rm -v "$RELAY_VOLUME:/data" -v "$WORK_DIR:/backup:ro" alpine:3.20 \
    sh -c 'cp /backup/relay.db /data/relay.db && chown 10001:10001 /data/relay.db'
  docker compose -f "$COMPOSE_FILE" start relay
fi

if [ -n "${RELAY_DB_FILE:-}" ]; then
  echo "restore: локальный режим — база на месте; запустите релей и проверьте /healthz"
  exit 0
fi

if command -v curl >/dev/null 2>&1; then
  BASE=${RELAY_BASE_URL:-http://127.0.0.1:8080}
  for _ in $(seq 1 30); do
    if curl -fsS -H 'X-Relay-Version: 1' "$BASE/healthz" >/dev/null 2>&1; then
      echo "restore: релей отвечает на $BASE/healthz"
      exit 0
    fi
    sleep 1
  done
  echo "restore: база восстановлена, но healthz не ответил за 30 с" >&2
  exit 1
fi
echo "restore: база восстановлена (curl нет — healthz не проверял)"
