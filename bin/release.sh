#!/usr/bin/env bash
#
# Собрать релиз: влить рабочую ветку develop в релизную main и, если просили,
# поставить тег. Только этот скрипт двигает main — задачи вливаются в develop
# через bin/task-commit.sh.
#
#   bin/release.sh [--dry-run] [--tag vX.Y.Z] [--message ТЕКСТ] [--skip-tests]
#
#   --dry-run      показать план, ничего не менять
#   --tag vX.Y.Z   поставить аннотированный тег после слияния (необязательно)
#   --message      сообщение merge-коммита (по умолчанию «release: <tag|дата>»)
#   --skip-tests   не гонять bin/test.sh (только осознанно: ревью и тесты —
#                  условие релиза, см. AGENTS.md «Ветвление и релизы»)
#
# Что проверяется до слияния: чистый рабочий каталог, наличие develop, наличие
# неслитых коммитов develop над main, прохождение bin/test.sh. Пуш не делается:
# это шаг человека — `git push origin main --follow-tags`.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY_RUN=0
TAG=""
MESSAGE=""
SKIP_TESTS=0

usage() {
  sed -n '3,/^set -euo pipefail/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --tag) TAG="${2:?--tag требует значения, например v0.3.0}"; shift 2 ;;
    --tag=*) TAG="${1#*=}"; shift ;;
    --message) MESSAGE="${2:?--message требует значения}"; shift 2 ;;
    --message=*) MESSAGE="${1#*=}"; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "неизвестная опция: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "$ROOT — не git-репозиторий" >&2
  exit 1
fi

if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "рабочий каталог не чист: релиз собирают из закоммиченного состояния." >&2
  git -C "$ROOT" status --short >&2
  exit 1
fi

for branch in main develop; do
  if ! git -C "$ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "нет ветки $branch — релиз невозможен" >&2
    exit 1
  fi
done

ahead="$(git -C "$ROOT" rev-list --count main..develop)"
subject="${MESSAGE:-release: ${TAG:-$(date -u +%Y-%m-%d)}}"

echo "релиз: develop → main"
echo "новых коммитов в develop: $ahead"
echo "сообщение коммита: $subject"
[[ -n "$TAG" ]] && echo "тег: $TAG"

if (( ahead == 0 )); then
  echo "develop не содержит неслитых коммитов — собирать нечего"
  exit 0
fi

if [[ -z "$TAG" ]]; then
  echo "предупреждение: без --tag релиз не помечен; тег можно поставить позже" >&2
else
  if git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    echo "тег $TAG уже существует" >&2
    exit 1
  fi
fi

if (( SKIP_TESTS == 0 )); then
  echo
  echo "== тесты перед релизом (bin/test.sh)"
  if (( DRY_RUN == 1 )); then
    echo "   dry-run: тесты не запускаю"
  else
    (cd "$ROOT" && ./bin/test.sh) || {
      echo "тесты не прошли — релиз остановлен" >&2
      exit 1
    }
  fi
fi

if (( DRY_RUN == 1 )); then
  echo
  echo "dry-run: ничего не изменено"
  exit 0
fi

echo
echo "== слияние"
git -C "$ROOT" checkout main >/dev/null
git -C "$ROOT" merge --no-ff develop -m "$subject" -m "Релиз из develop; ревью и тесты — см. AGENTS.md."

if [[ -n "$TAG" ]]; then
  git -C "$ROOT" tag -a "$TAG" -m "$subject"
  echo "тег $TAG поставлен на $(git -C "$ROOT" rev-parse --short HEAD)"
fi

echo
echo "релиз собран локально. Пуш — шаг человека:"
echo "  git push origin main${TAG:+ --follow-tags}"
echo "рабочая ветка снова develop:"
echo "  git checkout develop"
