#!/usr/bin/env bash
# Однократная подготовка VPS к выпускам модуля переговоров из GitHub Actions. Запускать от root:
#
#   ./install.sh "ssh-ed25519 AAAA... kam-deploy-github"
#
# Создаёт пользователя kam-deploy, которому разрешена ровно одна команда — kam-deploy;
# каталог данных на диске MDM (/srv/truedata-mdm/kam), /opt/truedata/kam и .env со случайным паролем базы,
# ключами демо-платформы и паролем страницы /demo-platform. Повторный запуск безопасен: .env не меняется.
set -euo pipefail

PUBKEY="${1:-}"
APP_DIR=/opt/truedata/kam
DATA_DIR=/srv/truedata-mdm/kam
HERE="$(cd "$(dirname "$0")" && pwd)"

die() { echo "ОСТАНОВКА: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "запустите от root"
[[ "$PUBKEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || die "передайте публичный ключ ssh-ed25519 одной строкой в кавычках"
[[ -f /srv/truedata-mdm/.mdm-data-disk ]] || die "диск данных MDM не смонтирован в /srv/truedata-mdm"
command -v docker >/dev/null || die "docker не установлен"
docker network inspect coolify >/dev/null 2>&1 || die "нет docker-сети coolify (Traefik)"

install -d -m 0755 "$DATA_DIR"
install -d -m 0700 -o 999 -g 999 "$DATA_DIR/pgdata"
install -d -m 0750 -o 1000 -g 1000 "$DATA_DIR/files" "$DATA_DIR/backups"

id kam-deploy >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash kam-deploy
usermod -aG docker kam-deploy
install -m 0755 "$HERE/kam-deploy" /usr/local/bin/kam-deploy

install -d -m 0750 -o kam-deploy -g kam-deploy "$APP_DIR"
if [[ ! -f "$APP_DIR/.env" ]]; then
  umask 077
  tmp=$(mktemp -d)
  openssl genpkey -algorithm ed25519 -out "$tmp/demo.key"
  openssl pkey -in "$tmp/demo.key" -pubout -out "$tmp/demo.pub"
  demo_pass=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
    echo "KAM_HOST=kam.demo.truedata.tech"
    echo "KAM_DATA_DIR=$DATA_DIR"
    echo "KAM_IMAGE="
    echo "FRAME_ANCESTORS=https://app.truedata.tech"
    echo "SSO_ISSUER=truedata-platform"
    echo "SSO_AUDIENCE=pharmacheck-kam"
    # На демо-стенде модуль принимает токены демо-платформы; при подключении настоящей платформы
    # в SSO_PUBLIC_KEY через пустую строку добавляется её открытый ключ.
    echo "SSO_PUBLIC_KEY=$(awk '{printf "%s\\n", $0}' "$tmp/demo.pub")"
    echo "SSO_DEMO_PRIVATE_KEY=$(awk '{printf "%s\\n", $0}' "$tmp/demo.key")"
    echo "DEMO_PLATFORM_PASSWORD=$demo_pass"
  } > "$APP_DIR/.env"
  rm -rf "$tmp"
  chown kam-deploy:kam-deploy "$APP_DIR/.env"
  chmod 0600 "$APP_DIR/.env"
  echo "создан $APP_DIR/.env; пароль страницы /demo-platform: $demo_pass"
fi
[[ -f "$APP_DIR/compose.yaml" ]] || install -m 0640 -o kam-deploy -g kam-deploy "$HERE/../compose.yaml" "$APP_DIR/compose.yaml"

install -d -m 0700 -o kam-deploy -g kam-deploy /home/kam-deploy/.ssh
echo "command=\"/usr/local/bin/kam-deploy\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $PUBKEY" \
  > /home/kam-deploy/.ssh/authorized_keys
chown kam-deploy:kam-deploy /home/kam-deploy/.ssh/authorized_keys
chmod 0600 /home/kam-deploy/.ssh/authorized_keys

echo
echo "Готово. Отпечаток ключа сервера — сверьте его с выводом ssh-keyscan на своём компьютере:"
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
