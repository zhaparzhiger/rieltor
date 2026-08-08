# Конфиг вшит в образ, а не примонтирован файлом: Docker Manager на Hostinger
# резолвит бинд-маунты относительно своей папки проекта, где файлов репозитория
# нет, и падает с «not a directory».
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
