#!/bin/bash

set -euo pipefail

export PORT="${PORT:-8080}"

mkdir -p \
  "${APP_DATA_DIR}/database" \
  "${AVATAR_STORAGE_DIR}" \
  "${UPLOAD_TEMP_DIR}"

./node_modules/.bin/prisma migrate deploy

envsubst '${PORT}' \
  < /etc/nginx/templates/gem-council.conf.template \
  > /etc/nginx/conf.d/gem-council.conf

nginx -t

node /app/dist-server/src/server/server.js &
APP_PID=$!

nginx -g 'daemon off;' &
NGINX_PID=$!

shutdown() {
  kill -TERM "${APP_PID}" "${NGINX_PID}" 2>/dev/null || true
  wait "${APP_PID}" "${NGINX_PID}" 2>/dev/null || true
}

trap 'shutdown; exit 0' TERM INT

set +e
wait -n "${APP_PID}" "${NGINX_PID}"
STATUS=$?
set -e

shutdown
exit "${STATUS}"
