# The duo serve daemon for Railway (docs/deploy/railway.md).
# Official Node 22 builds compile node:sqlite with FTS5, which the store's
# full-text index needs (README "Development") — checked at build time below.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')"
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY deploy/duo.sh /usr/local/bin/duo
COPY deploy/start.sh /app/start.sh
RUN chmod +x /usr/local/bin/duo /app/start.sh
# Every relative path the CLI uses (data/, duo/, *-runtime/) resolves under
# the volume, so `railway ssh` + `duo <cmd>` sees the daemon's own state.
ENV DUO_HOME=/data
WORKDIR /data
CMD ["/app/start.sh"]
