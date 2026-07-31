FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

#SQL миграций tsc не переносит — кладём рядом со скомпилированным migrate.js, который ищет их
#относительно себя (new URL("./migrations/", import.meta.url)).
COPY --from=build /app/src/migrations ./dist/migrations

USER node

#Мигратор запускается отдельной командой: node dist/migrate.js (см. .docker/README.md).
CMD ["node", "dist/main.js"]
