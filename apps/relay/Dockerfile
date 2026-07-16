FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile --filter @codever/relay... \
    && pnpm --filter @codever/relay build \
    && pnpm store prune

RUN mkdir -p /app/data \
    && chown node:node /app/data

USER node
EXPOSE 8787

CMD ["node", "apps/relay/dist/main.js"]
