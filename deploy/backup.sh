#!/usr/bin/env bash
# Бэкап состояния релея: SQLite-база (устройства, коды, вопросы, ответы).
#
# Использование:
#   deploy/backup.sh                      # docker compose (по умолчанию)
#   RELAY_DB_FILE=/data/relay.db deploy/backup.sh   # локальный файл (VPS/тест)
#
# Кладёт в $BACKUP_DIR (по умолчанию deploy/backups) архив
# relay-YYYYMMDDTHHMMSSZ.tar.gz с базой и manifest.json (sha256, время, версия).
# Старые бэкапы чистятся по RETENTION_DAYS (по умолчанию 14).
# Cron: 17 3 * * * cd /opt/dsh && deploy/backup.sh >> /var/log/dsh-backup.log 2>&1
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.yml}
BACKUP_DIR=${BACKUP_DIR:-$DEPLOY_DIR/backups}
RETENTION_DAYS=${RETENTION_DAYS:-14}
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR"

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dsh-backup.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT
DB_COPY=$WORK_DIR/relay.db

need() { command -v "$1" >/dev/null 2>&1 || { echo "backup: нужен $1" >&2; exit 1; }; }

need tar
need sha256sum
need sqlite3

if [ -n "${RELAY_DB_FILE:-}" ]; then
  echo "backup: локальный режим ($RELAY_DB_FILE)"
  [ -f "$RELAY_DB_FILE" ] || { echo "backup: нет файла $RELAY_DB_FILE" >&2; exit 1; }
  # .backup — консистентный снимок даже при работающем релее.
  sqlite3 "$RELAY_DB_FILE" ".backup '$DB_COPY'"
  RELAY_VERSION=${RELAY_VERSION:-local}
else
  need docker
  echo "backup: docker compose ($COMPOSE_FILE)"
  docker compose -f "$COMPOSE_FILE" exec -T relay sqlite3 /data/relay.db ".backup /data/relay-backup.db"
  docker compose -f "$COMPOSE_FILE" cp relay:/data/relay-backup.db "$DB_COPY"
  docker compose -f "$COMPOSE_FILE" exec -T relay rm -f /data/relay-backup.db
  # Релей не публикует 8080 на хост — спрашиваем версию изнутри контейнера.
  RELAY_VERSION=$(docker compose -f "$COMPOSE_FILE" exec -T relay \
    curl -fsS -H 'X-Relay-Version: 1' http://127.0.0.1:8080/healthz 2>/dev/null \
    | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)
  RELAY_VERSION=${RELAY_VERSION:-unknown}
fi

[ -s "$DB_COPY" ] || { echo "backup: снимок базы пуст" >&2; exit 1; }
sqlite3 "$DB_COPY" 'PRAGMA integrity_check;' | grep -qx 'ok' || {
  echo "backup: снимок не прошёл integrity_check" >&2; exit 1;
}

DB_SHA=$(sha256sum "$DB_COPY" | cut -d' ' -f1)
cat > "$WORK_DIR/manifest.json" <<JSON
{
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "relay.db",
  "sha256": "$DB_SHA",
  "relay_version": "$RELAY_VERSION",
  "retention_days": $RETENTION_DAYS
}
JSON

ARCHIVE=$BACKUP_DIR/relay-$TIMESTAMP.tar.gz
tar -czf "$ARCHIVE" -C "$WORK_DIR" relay.db manifest.json
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
echo "backup: готов $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1), sha256 $DB_SHA)"

# Ротация: удаляем архивы старше RETENTION_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -name 'relay-*.tar.gz*' -type f -mtime "+$RETENTION_DAYS" -print -delete \
  | sed 's/^/backup: удалён старый /'
