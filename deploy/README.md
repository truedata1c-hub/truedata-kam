# Стенд на московском VPS

Модуль работает рядом с MDM как отдельный Docker Compose project `truedata-kam`. Маршрут и сертификат выдаёт существующий Traefik (сеть `coolify`); адрес `kam.demo.truedata.tech` уже ведёт на сервер — для `*.demo.truedata.tech` настроена общая DNS-запись. База и файлы хранятся на диске данных MDM в отдельном каталоге `/srv/truedata-mdm/kam`.

## Подготовка (однократно)

Первый выпуск сделан скриптом `deploy/stand-release.sh` прямо на сервере. Чтобы дальше выпускать из GitHub, на Mac одна команда:

```sh
[ -f ~/.ssh/truedata_kam_deploy ] || ssh-keygen -q -t ed25519 -N "" -C kam-deploy-github -f ~/.ssh/truedata_kam_deploy && ssh root@185.39.206.103 "/root/kam-src/deploy/server/install.sh '$(cat ~/.ssh/truedata_kam_deploy.pub)' && chown -R kam-deploy:kam-deploy /opt/truedata/kam" && ssh-keyscan -t ed25519 185.39.206.103 2>/dev/null > ~/.ssh/truedata_kam_known_hosts && echo ГОТОВО
```

Ключ разрешает только запуск `kam-deploy` на сервере. Затем в GitHub: репозиторий → Settings → Environments → окружение `stand` → три секрета:

| Секрет | Значение |
| --- | --- |
| `VPS_HOST` | `185.39.206.103` |
| `VPS_SSH_KEY` | `pbcopy < ~/.ssh/truedata_kam_deploy` и вставить |
| `VPS_KNOWN_HOSTS` | `pbcopy < ~/.ssh/truedata_kam_known_hosts` и вставить |

Образ передаётся на сервер архивом через тот же ключ, вход сервера в реестр образов не нужен.

## Выпуск

Тег вида `v0.1.1` в репозитории или ручной запуск workflow `deploy`. GitHub прогоняет тесты, собирает образ и передаёт его на сервер; `kam-deploy` поднимает версию, поднимает версию и ждёт проверки состояния; если новая версия не поднялась — возвращает прежнюю.

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
