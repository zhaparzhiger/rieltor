# Деплой на Hostinger (Docker Manager)

Приложение приезжает двумя контейнерами:

- `rieltor` — само приложение, наружу не смотрит;
- `caddy` — принимает 80/443, сам получает сертификат Let's Encrypt и проксирует
  трафик на `rieltor:3007`.

Домен по умолчанию — **peakcut.online**.

## Перед запуском

1. **DNS.** A-запись `peakcut.online` → IP сервера. Проверить: `ping peakcut.online`
   должен отвечать нужным адресом. Пока DNS не резолвится, Let's Encrypt
   сертификат не выдаст и Caddy будет крутиться в ошибках.
2. **Порты 80 и 443 на сервере должны быть свободны.** Если там уже что-то висит
   (nginx, другой контейнер) — Caddy не поднимется. Проверить по SSH:
   `sudo ss -lntp | grep -E ':80 |:443 '`. Что делать, если заняты, — в конце файла.
3. **Репозиторий приватный.** Docker Manager собирает из Git, поэтому либо
   сделайте `zhaparzhiger/rieltor` публичным (секретов в нём нет — `.env` и ключи
   в `.gitignore`), либо разворачивайте по SSH, как в варианте B.

## Вариант A — Docker Manager из панели

1. hPanel → **VPS → Docker Manager → Create project**.
2. Указать репозиторий `https://github.com/zhaparzhiger/rieltor` и путь к
   `docker-compose.yml` (он в корне).
3. В разделе переменных окружения (Environment / `.env`) вставить содержимое
   `.env.docker.example`, заполнив значения — см. таблицу ниже.
4. **Deploy.** Первая сборка занимает 5–8 минут.

## Вариант B — по SSH (работает и с приватным репозиторием)

```bash
git clone https://github.com/zhaparzhiger/rieltor.git && cd rieltor
```

```bash
cp .env.docker.example .env && nano .env
```

```bash
docker compose up -d --build
```

## Что вставить в .env

| Переменная | Что вставить |
| --- | --- |
| `APP_DOMAIN` | `peakcut.online` |
| `ACME_EMAIL` | ваша почта для Let's Encrypt |
| `GEMINI_USE_VERTEX` | `0` для ключа AI Studio, `1` для сервисного аккаунта |
| `GEMINI_API_KEY` | ключ из Google AI Studio (если `GEMINI_USE_VERTEX=0`) |
| `GOOGLE_CLOUD_PROJECT` | `gen-lang-client-0537370402` (если Vertex) |
| `GOOGLE_CLOUD_LOCATION` | `global` (если Vertex) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | всё содержимое `google-key.json` **одной строкой** (если Vertex) |
| `GEMINI_MODEL` | `gemini-2.5-flash` |
| `KRISHA_COOKIE` | необязательно, см. ниже |

Проще всего взять ключ в Google AI Studio и оставить `GEMINI_USE_VERTEX=0` —
тогда три переменные `GOOGLE_*` не нужны вообще.

Если берёте Vertex, JSON надо схлопнуть в одну строку. На Windows:

```powershell
(Get-Content "C:\Users\zhiga\OneDrive\Рабочий стол\aether\google-key.json" -Raw) -replace "`r`n","" -replace "`n","" | Set-Clipboard
```

### Телефоны Krisha

Krisha отдаёт номер только вошедшим в аккаунт. Чтобы номера подтягивались сами,
скопируйте свою строку `Cookie` из DevTools (Network → любой запрос к krisha.kz)
в `KRISHA_COOKIE`. Это ваша сессия — храните как пароль. Без неё в карточке
видно превью «+7 701 …», а номер можно вписать руками, кнопка WhatsApp
соберётся сразу.

## Проверка после деплоя

1. `https://peakcut.online/api/health` → `{"ok":true,"ai":true,...}`.
   `ai:false` означает, что ключ Gemini не подхватился.
2. `https://peakcut.online/api/ai-ping` → модель отвечает
   (`quota:true` — упёрлись в квоту, подождать минуту).
3. Открыть сайт, нажать «Начать парсинг», смотреть лог слева.

Логи контейнеров:

```bash
docker compose logs -f --tail=100
```

## Если деплой падает на монтировании Caddyfile

```
error mounting "/docker/rieltor/Caddyfile" ... not a directory
```

Так было в первой версии compose: Docker Manager собирает образы из своего клона
в `/tmp`, а бинд-маунты резолвит относительно папки проекта, где файлов
репозитория нет, — Docker создавал там **папку** `Caddyfile` и падал. Сейчас
конфиг вшит в образ (`caddy.Dockerfile`), бинд-маунтов в compose не осталось.
Если после неудачной попытки на сервере осталась пустая папка, удалите её и
разверните заново:

```bash
sudo rm -rf /docker/rieltor/Caddyfile
```

Общее правило для этой панели: **только именованные тома, никаких `./file:` в
`volumes`**.

## Если 80 и 443 заняты

Убрать из `docker-compose.yml` сервис `caddy`, а сервису `rieltor` вместо
`expose` прописать проброс порта:

```yaml
    ports:
      - "3007:3007"
```

Тогда приложение открывается по `http://<IP сервера>:3007` (без HTTPS), а домен
навешивается тем прокси, который уже стоит на сервере — в его конфиг добавляется
`proxy_pass http://127.0.0.1:3007`.

## Обновление

```bash
git pull && docker compose up -d --build
```

Том `rieltor-data` при этом не трогается: кэш страниц, геокэш и последний
результат остаются на месте.

## Про сами источники

Krisha блокирует IP на уровне TCP за всплеск запросов, а OLX перестаёт отдавать
телефоны после серии обращений. На сервере IP дата-центра, поэтому такое
случается чаще, чем с домашнего интернета. Приложение это переживает — пишет в
лог понятную причину и работает с тем, что успело собрать.
