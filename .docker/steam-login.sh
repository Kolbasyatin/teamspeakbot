#!/usr/bin/env bash
# Первый (и повторный) Steam-логин для сервиса токенов Bohemia:
# логин, пароль, код Steam Guard -> arma-token-data/steam-auth.json.
#
# Стек останавливать не нужно — сервис подхватит файл на следующей попытке (до 1 минуты).
# --env-file обязателен: без него в compose не подставятся ${...} и он откажется читать файл.
set -euo pipefail

cd "$(dirname "$0")"

mkdir -p arma-token-data
# Контейнер работает не от root — каталог должен быть доступен на запись.
chmod 777 arma-token-data

docker compose --env-file env/secrets.env -f compose.prod.yaml \
    run --rm --interactive --tty bohemia-token-cli
