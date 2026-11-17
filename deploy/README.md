# Стенд на московском VPS

Модуль работает рядом с MDM как отдельный Docker Compose project `truedata-kam`. Маршрут и сертификат выдаёт существующий Traefik (сеть `coolify`); адрес `kam.demo.truedata.tech` уже ведёт на сервер — для `*.demo.truedata.tech` настроена общая DNS-запись. База и файлы хранятся на диске данных MDM в отдельном каталоге `/srv/truedata-mdm/kam`.

## Подготовка (однократно)

На своём компьютере, из папки репозитория:

```sh
# 1. Ключ, которым GitHub Actions будет выпускать версии
ssh-keygen -t ed25519 -N "" -C kam-deploy-github -f ~/.ssh/truedata_kam_deploy

# 2. Подготовка сервера: каталог данных, пользователь для выпусков, .env с паролями и ключами демо-платформы
scp -r deploy root@185.39.206.103:/root/kam-server-deploy
ssh root@185.39.206.103 "/root/kam-server-deploy/server/install.sh '$(cat ~/.ssh/truedata_kam_deploy.pub)'"
#    В конце скрипт покажет пароль страницы /demo-platform — сохраните его.

# 3. Отпечаток сервера для GitHub
ssh-keyscan -t ed25519 185.39.206.103 2>/dev/null > /tmp/kam_known_hosts
```

В GitHub: репозиторий → Settings → Environments → создать окружение `stand` и добавить секреты:

| Секрет | Значение |
| --- | --- |
| `VPS_HOST` | `185.39.206.103` |
| `VPS_SSH_KEY` | содержимое `~/.ssh/truedata_kam_deploy` (закрытый ключ) |
| `VPS_KNOWN_HOSTS` | содержимое `/tmp/kam_known_hosts` |

Чтобы сервер скачивал образы из реестра GitHub, один раз войти в реестр от имени пользователя выпусков (токен с правом `read:packages`):

```sh
ssh root@185.39.206.103 "sudo -u kam-deploy -H docker login ghcr.io -u <логин GitHub>"
```

## Выпуск

Тег вида `v0.1.0` в репозитории или ручной запуск workflow `deploy`. Скрипт `kam-deploy` на сервере берёт образ, поднимает версию и ждёт проверки состояния; если новая версия не поднялась — возвращает прежнюю.

После первого выпуска — демо-набор:

```sh
ssh root@185.39.206.103
cd /opt/truedata/kam
docker compose --env-file .env exec -e KAM_PASSWORD='<пароль демо-пользователей>' api node dist/src/cli.js seed-demo
```

## Адреса

- `https://kam.demo.truedata.tech/` — модуль с собственным меню и входом по паролю.
- `https://kam.demo.truedata.tech/demo-platform` — демо-платформа: модуль во встроенном окне со сквозным входом (пароль из шага 2).

## Подключение настоящей платформы

В `/opt/truedata/kam/.env` добавить открытый ключ платформы в `SSO_PUBLIC_KEY` (несколько ключей — подряд в одном значении), при необходимости поменять `SSO_ISSUER` и `FRAME_ANCESTORS`, затем `docker compose --env-file .env up -d`. Формат токена — в корневом README.
