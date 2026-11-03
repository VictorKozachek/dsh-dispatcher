#!/usr/bin/env bash
#
# Поставить dsh-remote в профиль DSH.
#
#   bin/install-remote.sh [--profile web|desktop] [--dry-run]
#   bin/install-remote.sh --update [--dry-run]
#   bin/install-remote.sh --rollback <версия> [--dry-run]
#
#   --profile <имя>  профиль DSH (по умолчанию web)
#   --dry-run        только напечатать план: ничего не пишет и не трогает ~/.dsh
#   --update         сравнить установленную версию с текущим пакетом и обновить
#   --rollback <v>   вернуть ранее установленную версию из кэша (~/.dsh/plugin-cache)
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
MODE="install"
ROLLBACK_VERSION=""

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
    --update)
      MODE="update"
      shift
      ;;
    --rollback)
      [[ $# -ge 2 ]] || { echo "у --rollback нужна версия" >&2; exit 2; }
      MODE="rollback"
      ROLLBACK_VERSION="$2"
      shift 2
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

case "$PROFILE" in
  web|desktop) ;;
  *)
    echo "неизвестный профиль: '$PROFILE' (ожидается web или desktop)" >&2
    exit 2
    ;;
esac

HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
CACHE_ROOT="$HOME_DIR/plugin-cache/$PLUGIN_NAME"
STATE_FILE="${DSH_REMOTE_STATE:-$HOME_DIR/remote-control/state.json}"

# Текущая версия пакета и версия схемы состояния, которую он поддерживает.
CURRENT_VERSION="$(python3 - "$PLUGIN_DIR/package.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8")).get("version", ""))
PY
)"
supported_schema() {
  python3 - "$1/lib/store.js" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"export const STATE_VERSION = (\d+)", text)
print(match.group(1) if match else "")
PY
}

# Версия, установленная в профиль (link-зависимость или node_modules).
installed_version() {
  python3 - "$PROFILE_DIR" "$PLUGIN_NAME" <<'PY'
import json, os, sys
profile, name = sys.argv[1], sys.argv[2]
manifest_path = os.path.join(profile, "package.json")
try:
    manifest = json.load(open(manifest_path, encoding="utf-8"))
except Exception:
    print("")
    raise SystemExit(0)
dep = (manifest.get("dependencies") or {}).get(name) or ""
candidate = dep[5:] if dep.startswith("link:") else os.path.join(profile, "node_modules", name)
package = os.path.join(candidate, "package.json")
try:
    print(json.load(open(package, encoding="utf-8")).get("version", ""))
except Exception:
    print("")
PY
}

# Каталог установленного пакета — для кэширования перед обновлением.
installed_dir() {
  python3 - "$PROFILE_DIR" "$PLUGIN_NAME" <<'PY'
import json, os, sys
profile, name = sys.argv[1], sys.argv[2]
manifest_path = os.path.join(profile, "package.json")
try:
    manifest = json.load(open(manifest_path, encoding="utf-8"))
except Exception:
    print("")
    raise SystemExit(0)
dep = (manifest.get("dependencies") or {}).get(name) or ""
print(dep[5:] if dep.startswith("link:") else os.path.join(profile, "node_modules", name))
PY
}

say() { printf '%s\n' "$*"; }
plan() { printf '  • %s\n' "$*"; }

if (( DRY_RUN == 1 )); then
  say "dsh-remote → профиль '$PROFILE' (dry-run)"
else
  say "dsh-remote → профиль '$PROFILE'"
fi
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
up_to_date=0
if [[ "$MODE" == "update" ]]; then
  installed="$(installed_version)"
  if [[ -n "$installed" && "$installed" == "$CURRENT_VERSION" ]]; then
    up_to_date=1
  fi
fi
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


# --- совместимость (032/035) -------------------------------------------------
# Перед установкой проверяем, что пакет хотя бы парсится и что состояние из
# будущего не будет молча испорчено: schemaVersion state.json ≤ поддерживаемой.
TARGET_DIR="$PLUGIN_DIR"
ROLLBACK_TARGET=""
if [[ "$MODE" == "rollback" ]]; then
  ROLLBACK_TARGET="$CACHE_ROOT/$ROLLBACK_VERSION"
  TARGET_DIR="$ROLLBACK_TARGET"
  if [[ ! -f "$ROLLBACK_TARGET/package.json" ]]; then
    problem "версия $ROLLBACK_VERSION не найдена в кэше: $CACHE_ROOT"
    cached="$(ls -1 "$CACHE_ROOT" 2>/dev/null | tr '\n' ' ' || true)"
    say "  доступные версии: ${cached:-нет}"
    say "  кэш пополняется при обновлении: --update"
  fi
fi

if [[ -f "$TARGET_DIR/package.json" ]]; then
  if ! node --check "$TARGET_DIR/lib/index.js" >/dev/null 2>&1; then
    problem "пакет $TARGET_DIR не проходит node --check (lib/index.js)"
    say "  переустановите пакет или выберите другую версию"
  fi
  target_schema="$(supported_schema "$TARGET_DIR")"
  if [[ -f "$STATE_FILE" && -n "$target_schema" ]]; then
    state_schema="$(python3 - "$STATE_FILE" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("")
    raise SystemExit(0)
value = data.get("schemaVersion", data.get("version"))
print(value if isinstance(value, int) else "")
PY
)"
    if [[ -n "$state_schema" && "$state_schema" -gt "$target_schema" ]]; then
      problem "state.json имеет schemaVersion $state_schema, а пакет поддерживает $target_schema"
      say "  состояние из будущего: обновите плагин или откатите state.json из бэкапа"
      say "  (бэкапы: ${STATE_FILE}.bak-*; установка не выполнена)"
    fi
  fi
fi

# --- план --------------------------------------------------------------------
say "план:"
if (( problems > 0 )); then
  plan "сначала устранить проблемы выше — без этого установка не начнётся"
elif [[ "$MODE" == "rollback" ]] && [[ -n "$ROLLBACK_TARGET" ]]; then
  plan "откат: $(installed_version || true) → $ROLLBACK_VERSION из кэша $ROLLBACK_TARGET"
  plan "link:$ROLLBACK_TARGET в dependencies профиля (бандл не меняется)"
  plan "перезапуск профиля после отката"
elif [[ "$MODE" == "update" ]] && (( up_to_date == 1 )); then
  plan "уже установлена версия $CURRENT_VERSION — обновление не требуется (идемпотентно)"
elif [[ "$MODE" == "update" ]]; then
  installed_now="$(installed_version)"
  plan "обновление ${installed_now:-<не установлен>} → $CURRENT_VERSION"
  if [[ -n "$installed_now" && "$installed_now" != "$CURRENT_VERSION" ]]; then
    plan "перед заменой старая версия копируется в кэш: $CACHE_ROOT/$installed_now"
  fi
  plan "проверка совместимости: node --check и schemaVersion состояния — выполнена выше"
  plan "после установки — перезапуск профиля"
elif (( already == 1 )); then
  plan "пакет уже объявлен зависимостью и бандлом профиля '$PROFILE' — менять нечего"
else
  if [[ "${DSH_INSTALL_NO_DSH:-0}" != "1" ]] && command -v dsh >/dev/null 2>&1; then
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

if [[ "$MODE" == "update" ]] && (( up_to_date == 1 )); then
  say "пакет уже установлен ($CURRENT_VERSION) — обновление не требуется."
  exit 0
fi

if [[ "$MODE" == "rollback" ]]; then
  say "откат на $ROLLBACK_VERSION..."
  mkdir -p "$PROFILE_DIR/node_modules"
  ln -sfn "$ROLLBACK_TARGET" "$PROFILE_DIR/node_modules/$PLUGIN_NAME"
  python3 - "$MANIFEST" "$ROLLBACK_TARGET" "$PLUGIN_NAME" <<'PY'
import json, sys
from pathlib import Path
manifest_path, plugin_dir, plugin_name = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest.setdefault("dependencies", {})[plugin_name] = f"link:{plugin_dir}"
profile = manifest.setdefault("dsh", {}).setdefault("profile", {})
bundles = profile.setdefault("bundles", [])
if plugin_name not in bundles:
    bundles.append(plugin_name)
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  say "откат выполнен: $PLUGIN_NAME $ROLLBACK_VERSION ($ROLLBACK_TARGET)"
  say "перезапустите профиль и проверьте /remote doctor"
  exit 0
fi

# Обновление: сохраняем текущую версию в кэш до подмены.
if [[ "$MODE" == "update" ]]; then
  old_version="$(installed_version)"
  old_dir="$(installed_dir)"
  if [[ -n "$old_version" && -n "$old_dir" && -f "$old_dir/package.json" && ! -f "$CACHE_ROOT/$old_version/package.json" ]]; then
    mkdir -p "$CACHE_ROOT"
    tmp_cache="$CACHE_ROOT/$old_version.tmp.$$"
    rm -rf "$tmp_cache"
    cp -R "$old_dir" "$tmp_cache"
    rm -rf "$CACHE_ROOT/$old_version"
    mv "$tmp_cache" "$CACHE_ROOT/$old_version"
    chmod -R go-rwx "$CACHE_ROOT/$old_version" 2>/dev/null || true
    say "старая версия $old_version сохранена в кэш: $CACHE_ROOT/$old_version"
  fi
  already=0
fi

if (( already == 1 )); then
  say "пакет уже установлен — пропускаю."
  exit 0
fi

# --- установка ---------------------------------------------------------------
manual=0
if [[ "${DSH_INSTALL_NO_DSH:-0}" != "1" ]] && command -v dsh >/dev/null 2>&1; then
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
