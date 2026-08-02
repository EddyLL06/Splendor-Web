# syntax=docker/dockerfile:1

FROM node:24-bookworm AS build

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --include=dev --no-audit --no-fund

COPY . .

ARG VITE_GAME_SERVER_URL=
ENV VITE_GAME_SERVER_URL=${VITE_GAME_SERVER_URL}

RUN npm test
RUN npm run build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        gettext-base \
        nginx-light \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default \
    && rm -f /etc/nginx/conf.d/default.conf

ENV NODE_ENV=production
ENV GAME_SERVER_PORT=8000
ENV APP_DATA_DIR=/data
ENV DATABASE_URL=file:/data/database/app.sqlite
ENV AVATAR_STORAGE_DIR=/data/avatars
ENV UPLOAD_TEMP_DIR=/data/tmp

COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/package-lock.json /app/package-lock.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/dist-server /app/dist-server
COPY --from=build /app/prisma /app/prisma
COPY --from=build /app/prisma.config.ts /app/prisma.config.ts

COPY railway-nginx.conf.template /etc/nginx/templates/gem-council.conf.template
COPY railway-entrypoint.sh /app/railway-entrypoint.sh

RUN chmod 0755 /app/railway-entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/railway-entrypoint.sh"]
