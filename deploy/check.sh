#!/usr/bin/env bash
# Проверка deploy-набора без запуска контейнеров:
#   - синтаксис всех скриптов (bash -n);
#   - обязательные файлы и ключи .env.example;
#   - docker compose config (если docker CLI есть и демон не нужен).
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$DEPLOY_DIR"

fail() { echo "check: FAIL — $*" >&2; exit 1; }

for file in backup.sh restore.sh smoke.sh check.sh test-local.sh; do
  [ -f "$file" ] || fail "нет $file"
  bash -n "$file" || fail "bash -n $file"
  echo "check: bash -n $file ok"
done

for file in docker-compose.yml relay.Dockerfile Caddyfile .env.example README.md; do
  [ -s "$file" ] || fail "нет/пуст $file"
  echo "check: $file на месте"
done

grep -q '^RELAY_DOMAIN=' .env.example || fail ".env.example без RELAY_DOMAIN"
grep -q '^RELAY_AGENT_TOKEN=' .env.example || fail ".env.example без RELAY_AGENT_TOKEN"
grep -q 'reverse_proxy relay:8080' Caddyfile || fail "Caddyfile без reverse_proxy relay:8080"
grep -q 'healthcheck' docker-compose.yml || fail "compose без healthcheck"
grep -q 'restart: unless-stopped' docker-compose.yml || fail "compose без restart policy"
grep -q 'sqlite:///data/relay.db' docker-compose.yml || fail "compose без тома БД"

if command -v docker >/dev/null 2>&1; then
  if docker compose -f docker-compose.yml --env-file .env.example config -q 2>/dev/null; then
    echo "check: docker compose config ok"
  else
    echo "check: docker compose config пропущен (нет демона?)" >&2
  fi
else
  echo "check: docker CLI нет — compose config пропущен"
fi

echo "check: OK"
