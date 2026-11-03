#!/usr/bin/env bash
# Smoke-тест релея: healthcheck → привязка → вопрос → ответ → идемпотентный повтор.
#
#   RELAY_BASE_URL=https://relay.example.com RELAY_AGENT_TOKEN=... deploy/smoke.sh
#
# Сеть: только к указанному релею. Нужен curl и python3 (разбор JSON).
set -euo pipefail

BASE=${RELAY_BASE_URL:-http://127.0.0.1:8080}
BASE=${BASE%/}
: "${RELAY_AGENT_TOKEN:?RELAY_AGENT_TOKEN обязателен (токен агента релея)}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "smoke: нужен $1" >&2; exit 1; }; }
need curl
need python3

WORK=$(mktemp -d "${TMPDIR:-/tmp}/dsh-smoke.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

json() { python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {"d": data}))' "$1" "$2"; }
status() { printf '%s' "$1"; }

req() { # req METHOD PATH AUTH BODY -> "status code"
  local method=$1 path=$2 auth=$3 body=${4:-}
  local out=$WORK/resp.json
  local args=(-sS -o "$out" -w '%{http_code}' -X "$method" -H 'X-Relay-Version: 1' -H 'content-type: application/json')
  [ -n "$auth" ] && args+=(-H "authorization: Bearer $auth")
  [ -n "$body" ] && args+=(--data "$body")
  STATUS=$(curl "${args[@]}" "$BASE$path")
  export STATUS
  echo "$STATUS"
}

fail() { echo "smoke: FAIL — $*" >&2; exit 1; }

echo "smoke: healthz"
CODE=$(req GET /healthz "" "")
[ "$CODE" = "200" ] || fail "healthz вернул $CODE"
[ "$(json "$WORK/resp.json" 'd["ok"]')" = "True" ] || fail "healthz ok != true"

echo "smoke: код привязки"
CODE=$(req POST /v1/pairing "$RELAY_AGENT_TOKEN" "")
[ "$CODE" = "201" ] || fail "POST /v1/pairing вернул $CODE"
PAIR_CODE=$(json "$WORK/resp.json" 'd["pairCode"]')

echo "smoke: устройство"
PUBLIC_KEY=$(openssl rand -base64 32 2>/dev/null || python3 -c 'import base64,os;print(base64.b64encode(os.urandom(32)).decode())')
CODE=$(req POST /v1/devices "" "{\"platform\":\"ios\",\"publicKey\":\"$PUBLIC_KEY\"}")
case "$CODE" in 200|201) ;; *) fail "POST /v1/devices вернул $CODE";; esac
DEVICE_ID=$(json "$WORK/resp.json" 'd["deviceId"]')

echo "smoke: привязка"
CODE=$(req POST /v1/pair "" "{\"pairCode\":\"$PAIR_CODE\",\"deviceId\":\"$DEVICE_ID\"}")
[ "$CODE" = "200" ] || fail "POST /v1/pair вернул $CODE"
DEVICE_TOKEN=$(json "$WORK/resp.json" 'd["deviceToken"]')

echo "smoke: вопрос"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EXPIRES=$(python3 -c 'import datetime; print((datetime.datetime.now(datetime.UTC)+datetime.timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ"))')
QUESTION_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
SHORT_ID=$(python3 -c 'import secrets; print(secrets.token_hex(4))')
QUESTION=$(printf '{"question":{"id":"%s","shortId":"%s","workspace":"/smoke","taskId":"022","role":"worker","title":"smoke","body":"Продолжать?","options":[{"id":"o1","label":"Да"},{"id":"o2","label":"Нет"}],"createdAt":"%s","expiresAt":"%s"},"version":1}' \
  "$QUESTION_ID" "$SHORT_ID" "$NOW" "$EXPIRES")
CODE=$(req POST /v1/questions "$RELAY_AGENT_TOKEN" "$QUESTION")
[ "$CODE" = "201" ] || fail "POST /v1/questions вернул $CODE"

echo "smoke: устройство видит вопрос"
CODE=$(req GET "/v1/questions?limit=100" "$DEVICE_TOKEN" "")
[ "$CODE" = "200" ] || fail "GET /v1/questions вернул $CODE"
FOUND=$(json "$WORK/resp.json" "any(item.get('id')=='$QUESTION_ID' for item in d['questions'])")
[ "$FOUND" = "True" ] || fail "вопрос $QUESTION_ID не попал в список устройства"

echo "smoke: ответ"
KEY=$(python3 -c 'import uuid; print(uuid.uuid4())')
ANSWER=$(printf '{"questionId":"%s","selected":["o1"],"answeredAt":"%s","idempotencyKey":"%s"}' "$QUESTION_ID" "$NOW" "$KEY")
CODE=$(req POST /v1/answers "$DEVICE_TOKEN" "$ANSWER")
[ "$CODE" = "201" ] || fail "POST /v1/answers вернул $CODE"

echo "smoke: агент читает ответ"
CODE=$(req GET "/v1/answers?questionId=$QUESTION_ID" "$RELAY_AGENT_TOKEN" "")
[ "$CODE" = "200" ] || fail "GET /v1/answers вернул $CODE"
SELECTED=$(json "$WORK/resp.json" 'd["selected"][0]')
[ "$SELECTED" = "o1" ] || fail "ответ не тот: $SELECTED"

echo "smoke: повтор идемпотентен"
CODE=$(req POST /v1/answers "$DEVICE_TOKEN" "$ANSWER")
[ "$CODE" = "200" ] || fail "повтор ответа вернул $CODE (ожидался 200)"

echo "smoke: OK — healthz, привязка, вопрос, ответ, идемпотентность"
