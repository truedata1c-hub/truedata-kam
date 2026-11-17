#!/usr/bin/env bash
# Выпуск на стенде из исходников, без GitHub Actions. Запускать от root на VPS из распакованной папки репозитория:
#
#   ./deploy/stand-release.sh <версия>
#
# Порядок: подготовка сервера (install.sh, повторный запуск безопасен) → сборка образа на сервере →
# запуск через kam-deploy (проверка состояния и откат при неудаче) → демо-набор при первом выпуске.
set -euo pipefail

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$ ]] || { echo "использование: $0 <версия>" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "запустите от root" >&2; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/truedata/kam

free_mb=$(df -Pm / | awk 'NR==2 {print $4}')
(( free_mb >= 3000 )) || { echo "на системном диске свободно ${free_mb} МБ — для сборки нужно не меньше 3000" >&2; exit 1; }

"$SRC/deploy/server/install.sh"

echo "[stand-release] сборка образа truedata-kam:$VERSION"
docker build -q --build-arg APP_VERSION="$VERSION" -t "truedata-kam:$VERSION" "$SRC" >/dev/null

/usr/local/bin/kam-deploy local "$VERSION"

cd "$APP_DIR"
dc() { docker compose --env-file .env -f compose.yaml "$@"; }
if [[ "$(dc exec -T db psql -U kam -d kam -tAc "select count(*) from kam.client where code='DEMO'")" == 0 ]]; then
  echo "[stand-release] загрузка демо-набора"
  pass=$(grep -E '^KAM_DEMO_PASSWORD=' .env | cut -d= -f2-)
  dc exec -T -e KAM_PASSWORD="$pass" api node dist/src/cli.js seed-demo
fi
chown -R kam-deploy:kam-deploy "$APP_DIR"
docker builder prune -f --filter until=24h >/dev/null 2>&1 || true

host=$(grep -E '^KAM_HOST=' .env | cut -d= -f2-)
echo
echo "Готово: версия $VERSION"
echo "  Модуль:          https://$host/"
echo "  Демо-платформа:  https://$host/demo-platform   пароль: $(grep -E '^DEMO_PLATFORM_PASSWORD=' .env | cut -d= -f2-)"
echo "  Демо-пользователи: <имя>@demo.truedata.tech     пароль: $(grep -E '^KAM_DEMO_PASSWORD=' .env | cut -d= -f2-)"
