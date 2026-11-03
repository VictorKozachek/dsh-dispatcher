#!/usr/bin/env bash
#
# Поставить dsh-remote в профиль DSH.
#
#   bin/install-remote.sh [--profile web|desktop] [--dry-run]
#
#   --profile <имя>  профиль DSH (по умолчанию web)
#   --dry-run        только напечатать план: ничего не пишет и не трогает ~/.dsh
#
# Штатный путь: пакет объявляет dsh.bundle, поэтому `dsh plugin add` дописывает
# его в dsh.profile.bundles профиля, а cordis.patch.yml пакета вставляет
# Loader-ряд ui-remote. Руками патч профиля не правится.
#
# Профиль `desktop` управляется приложением: `dsh plugin` для него отказывается
# работать, поэтому скрипт делает то же сам — link-зависимость, запись в
# dsh.profile.bundles и симлинк в node_modules профиля.
#
# Двойной ряд ui-remote (бандл плюс ручная вставка) — ошибка: плагин смонтируется
# дважды. Скрипт останавливается и объясняет, что убрать.
#
# Скрипт идемпотентен: повторный запуск ничего не меняет и говорит об этом.
# Установку в живой профиль запускает человек/оркестратор, а не агент.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_NAME="dsh-remote"
PLUGIN_DIR="$ROOT/$PLUGIN_NAME"
PROFILE="web"
DRY_RUN=0

usage() {
  sed -n '3,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { echo "у --profile нужно имя профиля" >&2; exit 2; }
      PROFILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "неизвестная опция: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      echo "лишний аргумент: $1 (профиль задаётся через --profile)" >&2
      exit 2
      ;;
  esac
done

HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

say() { printf '%s\n' "$*"; }
plan() { printf '  • %s\n' "$*"; }

say "dsh-remote → профиль '$PROFILE'${DRY_RUN:+ (dry-run)}"
say "пакет:  $PLUGIN_DIR"
say "профиль: $PROFILE_DIR"
say ""

problems=0
problem() {
  problems=$((problems + 1))
  printf 'проблема: %s\n' "$*" >&2
}

# --- что уже есть ------------------------------------------------------------
if [[ ! -f "$PLUGIN_DIR/package.json" ]]; then
  problem "не найден пакет плагина: $PLUGIN_DIR"
fi

profile_ready=1
if [[ ! -f "$MANIFEST" ]]; then
  profile_ready=0
  problem "профиль '$PROFILE' не инициализирован: нет $MANIFEST"
  say "  (запустите профиль один раз — DSH создаст его при первом старте)"
fi

already=0
if (( profile_ready == 1 )); then
  if python3 - "$MANIFEST" "$PLUGIN_NAME" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)
deps = manifest.get("dependencies") or {}
bundles = ((manifest.get("dsh") or {}).get("profile") or {}).get("bundles") or []
sys.exit(0 if sys.argv[2] in deps and sys.argv[2] in bundles else 1)
PY
  then
    already=1
  fi

  # Ручной ряд в патч-слое профиля: двойной монтаж.
  if [[ -f "$PATCH_FILE" ]] && grep -q 'ui-remote' "$PATCH_FILE"; then
    problem "в $PATCH_FILE уже есть ряд ui-remote (ручная вставка): плагин смонтируется дважды."
    say "  уберите ряд ui-remote из cordis.patch.yml профиля и запустите установщик снова."
  fi
fi

# --- план --------------------------------------------------------------------
say "план:"
if (( problems > 0 )); then
  plan "сначала устранить проблемы выше — без этого установка не начнётся"
elif (( already == 1 )); then
  plan "пакет уже объявлен зависимостью и бандлом профиля '$PROFILE' — менять нечего"
else
  if command -v dsh >/dev/null 2>&1; then
    plan "dsh plugin --profile $PROFILE add $PLUGIN_DIR"
  else
    plan "dsh не найден в PATH — поставлю вручную:"
    plan "  link:$PLUGIN_DIR в dependencies профиля"
    plan "  '$PLUGIN_NAME' в dsh.profile.bundles"
    plan "  симлинк node_modules/$PLUGIN_NAME → $PLUGIN_DIR"
  fi
  plan "перезапуск профиля: DSH Web — 'dsh web', приложение — закрыть и открыть"
  plan "правый сайдбар → «+» → таб «Удалённое управление»"
  plan "привязка бота: /remote connect в сессии"
fi
say ""

if (( DRY_RUN == 1 )); then
  say "dry-run: ничего не изменено."
  exit 0
fi

if (( problems > 0 )); then
  say "установка не выполнена: устранены не все проблемы." >&2
  exit 1
fi

if (( already == 1 )); then
  say "пакет уже установлен — пропускаю."
  exit 0
fi

# --- установка ---------------------------------------------------------------
manual=0
if command -v dsh >/dev/null 2>&1; then
  err=""
  if err="$(dsh plugin --profile "$PROFILE" add "$PLUGIN_DIR" 2>&1)"; then
    printf '%s\n' "$err"
  elif [[ "$err" == *"managed exclusively"* ]]; then
    say "профиль '$PROFILE' управляется приложением — ставлю пакет сам"
    manual=1
  else
    printf '%s\n' "$err" >&2
    say "не удалось: dsh plugin завершился с ошибкой" >&2
    exit 1
  fi
else
  say "команда dsh не найдена в PATH — ставлю пакет сам"
  manual=1
fi

if (( manual == 1 )); then
  mkdir -p "$PROFILE_DIR/node_modules"
  ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/$PLUGIN_NAME"
  python3 - "$MANIFEST" "$PLUGIN_DIR" "$PLUGIN_NAME" <<'PY'
import json
import sys
from pathlib import Path

manifest_path, plugin_dir, plugin_name = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
dependencies = manifest.setdefault("dependencies", {})
dependencies[plugin_name] = f"link:{plugin_dir}"
profile = manifest.setdefault("dsh", {}).setdefault("profile", {})
bundles = profile.setdefault("bundles", [])
if plugin_name not in bundles:
    bundles.append(plugin_name)
# Тот же формат, что пишет сам DSH: два пробела, перевод строки в конце.
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"манифест профиля обновлён: link:{plugin_dir} и бандл {plugin_name}")
PY
fi

say ""
say "Готово. Дальше:"
say "  1. перезапустите профиль — новый пакет читается при старте"
say "  2. откройте правый сайдбар («+») → таб «Удалённое управление»"
say "  3. привяжите бота: /remote connect (или задайте config.telegram в профиле)"
say "  4. проверка: /remote doctor и /remote status"
