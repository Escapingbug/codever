FROM golang:1.25-bookworm AS nsc-builder

RUN /usr/local/go/bin/go install github.com/nats-io/nsc/v2@v2.15.0

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

COPY --from=nsc-builder /go/bin/nsc /usr/local/bin/nsc

COPY . .
RUN pnpm install --frozen-lockfile --filter @codever/relay... \
    && pnpm --filter @codever/relay build \
    && pnpm store prune

RUN mkdir -p /app/data \
    && chown node:node /app/data

USER node
EXPOSE 8787

CMD ["node", "apps/relay/dist/main.js"]
