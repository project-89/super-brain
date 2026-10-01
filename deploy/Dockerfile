FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter '@_89/super-brain-api...' build
# Public build configuration only. No runtime credential is embedded in Brain.
ENV VITE_FOLD_API_BASE_URL=/api
RUN pnpm --filter '@_89/super-brain...' build

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/api ./apps/api
USER node
CMD ["node", "apps/api/dist/main.js", "serve"]

FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS brain
COPY --from=build /app/apps/brain/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
RUN chown -R 1000:1000 /data /config
USER 1000:1000
