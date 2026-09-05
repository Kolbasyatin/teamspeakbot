# Рантайм в Docker

Два окружения, оба описаны здесь целиком, кроме чувствительных данных: их место занимают
`env/*.example`, а настоящие файлы гитигнорятся (`.docker/env/*.env`).

| файл | что |
|---|---|
| `compose.dev.yaml` | разработка: MariaDB, а под профилями — TeamSpeak и приложение |
| `compose.prod.yaml` | прод: TeamSpeak + MariaDB + приложение + сервис токенов Bohemia, образы из GHCR |
| `mariadb/init/01-databases.sql` | провижининг баз `tsbot` и `tsbot_test` (не миграция схемы) |
| `Dockerfile` | образ для сервиса `app` из дев-compose (node + git), не для прода |
| `env/secrets.env.example` | пароли — единственное их место |
| `env/tsbot.env.example` | конфигурация приложения (паролей в проде не содержит) |
| `systemd/teamspeak6.service` | юнит, которым прод-стек запускается и контролируется на машине |
| `steam-login.sh` | интерактивный Steam-логин для сервиса токенов Bohemia |

Прод и дев **изолированы по построению**: разные имена проектов (`teamspeak6` против `tsbot-dev`)
и разные имена томов, поэтому дев-окружение не может подключиться к прод-данным или затереть их.

## Разработка

```bash
cd .docker
docker compose -f compose.dev.yaml up -d          # только MariaDB
```

Этого достаточно для обычной работы: приложение и тесты запускаются **на хосте**
(`npm run dev`, `npm test`) и находят базу по `localhost:3306` — ровно то, что прописано
в закоммиченных `.env` и `.env.test`. Пароли в дев-compose не секретные и совпадают с ними,
поэтому ничего настраивать не нужно.

При первой инициализации тома создаются три базы: `teamspeak` (её ведёт TeamSpeak-сервер),
`tsbot` (разработка) и `tsbot_test` (тесты). Скрипты из `mariadb/init` выполняются **только**
при первом создании тома. Если базы не появились — снести том и поднять заново:

```bash
docker compose -f compose.dev.yaml down
docker volume rm tsbot-dev-mariadb-data
docker compose -f compose.dev.yaml up -d
```

Профили — то, что нужно не всегда:

```bash
docker compose -f compose.dev.yaml --profile teamspeak up -d   # + TeamSpeak 6 на 10022
docker compose -f compose.dev.yaml --profile app up -d         # + приложение в контейнере
```

Для профилей `teamspeak` и `app`:
- TeamSpeak-сервер поднимается с ServerQuery-паролем `devquery`, то же значение нужно положить
  в `TS_PASSWORD` своего `.env.local`;
- сервису `app` нужен `env/tsbot.env` (скопировать из `env/tsbot.env.example`). Хосты БД
  и TeamSpeak compose подставит сам — внутри сети это имена сервисов, а не `localhost`.
  А вот пароли, в отличие от прода, здесь берутся из самого файла: `TS_PASSWORD=devquery`
  и `DB_PASSWORD=mypassword` — дев-значения из `compose.dev.yaml`, не секреты.

## Прод

На машине нужны два файла, которых нет в репозитории:

```bash
cp env/secrets.env.example env/secrets.env      # пароли БД и ServerQuery
cp env/tsbot.env.example  env/tsbot.env         # конфигурация приложения
```

Пароли заполняются **только** в `secrets.env`. В `tsbot.env` их дублировать не нужно: одно
значение в двух файлах рано или поздно разъезжается, поэтому прод-compose передаёт пароли
приложению сам — `TS_PASSWORD` из `TS_QUERY_ADMIN_PASSWORD`, `DB_PASSWORD` из `TS_DB_PASSWORD`.
Переменная окружения контейнера перебивает `.env.local`: dotenv-flow не трогает то, что уже есть
в `process.env`, а convict читает именно его. `TS_QUERY_ADMIN_PASSWORD` — это и есть пароль
`serveradmin`, тот самый, которым ходят руками по SSH на порт 10022.

Стек запускается не руками, а через systemd — `systemd/teamspeak6.service`:

```bash
sudo cp systemd/teamspeak6.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now teamspeak6
```

Юнит один на весь compose-проект: systemd владеет стеком целиком и отдельными контейнерами
не управляет. Поэтому в `compose.prod.yaml` нет политик `restart` — иначе docker поднимал бы
упавший контейнер сам, systemd об аварии не узнавал бы, а `systemctl status` показывал бы,
что всё в порядке. Хозяин перезапуска ровно один.

```bash
systemctl status teamspeak6      # состояние
systemctl restart teamspeak6     # перезапуск стека
journalctl -u teamspeak6 -f      # логи всех контейнеров одним потоком
```

Обновление на новый образ — pull и перезапуск (`pull` не в юните намеренно: перезапуск сервиса
не должен незаметно менять версию приложения):

```bash
cd /opt/teamspeakbot/.docker
docker compose --env-file env/secrets.env -f compose.prod.yaml pull
sudo systemctl restart teamspeak6
```

`--env-file` обязателен в любой ручной команде compose: без него не подставятся
`${TS_DB_PASSWORD}` и остальные пароли. Юнит его подставляет сам.

Образ приложения собирается workflow'ом `Build Docker Images` в GitHub Actions: автоматически
при каждом push в `master`, затронувшем `teamSpeakMonitoring/` (после typecheck и unit-тестов),
или вручную через «Run workflow». Публикуется в GHCR тегами `latest` и `sha-<коммит>`.

### Сервис токенов Bohemia

Очередь на вход серверов Arma Reforger приложение берёт из каталога Bohemia, а токен для него
добывает сервис из репозитория `arma-reforger-hz`. Код у него свой, деплой — общий: сервис
`bohemia-token` описан прямо в `compose.prod.yaml`, образ тянется из
`ghcr.io/kolbasyatin/arma-reforger-hz`. Отдельного compose и отдельного юнита `arma-reforger`
больше нет, как и внешней сети `arma-shared`: внутри одного проекта хватает сети по умолчанию.

Имя контейнера оставлено прежним, `arma-reforger-hz`, поэтому
`BOHEMIA_TOKEN_URL=http://arma-reforger-hz:8080/token` в `tsbot.env` менять не нужно. Имя сервиса
`bohemia-token` резолвится в той же сети, так что оба адреса рабочие. Порт наружу не публикуется.

Приложение переживает недоступность сервиса токенов: очередь не собирается, в лог уходит один
`warn` на эпизод, всё остальное работает. Обратное неверно — теперь это один стек, и падение
сервиса токенов роняет `up` целиком, то есть перезапускает и TeamSpeak.

Состояние Steam-аутентификации (refresh token) лежит в `arma-token-data/steam-auth.json`
рядом с compose. Каталог гитигнорится. Логин делается один раз, скриптом:

```bash
cd /opt/teamspeakbot/.docker
./steam-login.sh        # логин, пароль, код Steam Guard
```

Повторный логин нужен, если Steam отозвал refresh token — в логе `Steam logon failed`.
Стек при этом останавливать не надо: файл подхватится в течение минуты.

```bash
docker logs -f arma-reforger-hz    # проверить, что токен получен
```

Локально (разработка) сервис запускается в docker с проброшенным портом, и в `.env.dev.local`
кладётся `BOHEMIA_TOKEN_URL=http://localhost:8080/token`.

#### Переезд со старой схемы

Пока на машине жив юнит `arma-reforger`, два стека будут драться за имя контейнера
`arma-reforger-hz`. Порядок такой:

```bash
sudo systemctl disable --now arma-reforger
sudo rm /etc/systemd/system/arma-reforger.service
sudo systemctl daemon-reload

# состояние Steam переносится как есть — повторный логин не нужен
sudo mv /opt/arma-reforger-hz/data /opt/teamspeakbot/.docker/arma-token-data

sudo systemctl restart teamspeak6
```

Сеть `arma-shared` после этого никому не нужна: `docker network rm arma-shared`.

### Схема БД

Миграции применяет **отдельный процесс**, а не приложение: в прод-compose это одноразовый сервис
`migrate` (`node dist/migrate.js`), а `ts-monitoring` ждёт его успешного завершения через
`depends_on: {condition: service_completed_successfully}`. Упавшая миграция означает, что приложение
не поднимется вовсе — это лучше, чем работать на неверной схеме. Ничего вызывать руками не нужно:
старт стека прогоняет миграции сам, то есть каждый `systemctl start|restart teamspeak6`.
Отдельного systemd-юнита у миграций нет намеренно: порядок и ожидание уже описаны в compose,
и они должны работать одинаково — и под systemd, и при ручном `docker compose up`.

В разработке — командой из `teamSpeakMonitoring/`:

```bash
npm run migrate          # применит недостающие миграции к базе из .env
DB_NAME=tsbot_test npm run migrate   # к любой другой, если нужно
```

Файлы миграций — `teamSpeakMonitoring/src/migrations/NNN_описание.sql`, применяются по возрастанию
номера, применённые версии лежат в таблице `schema_migrations`. **Применённую миграцию править
нельзя** — мигратор сверяет контрольную сумму и откажется работать; вместо правки добавляется
новый файл.
