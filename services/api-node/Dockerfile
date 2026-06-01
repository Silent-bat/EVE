# Multi-stage build: install all deps with pnpm, then ship a slim runtime image.

# ---- Builder ----------------------------------------------------------------
FROM node:22-alpine AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apk add --no-cache libc6-compat \
 && corepack enable \
 && corepack prepare pnpm@10.13.1 --activate

WORKDIR /workspace

# Copy lockfile + workspace manifest first for better layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json ./
COPY services/api-node/package.json services/api-node/
COPY apps/mobile/package.json apps/mobile/

# Install backend deps only (skip apps/mobile which is RN/Expo)
RUN pnpm install --frozen-lockfile --filter @eve/api... --prod

# Copy source last to maximize cache reuse on dep changes
COPY services/api-node ./services/api-node

# ---- Runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV API_PORT=8080
ENV EVE_DATA_DIR=/app/.eve-data
ENV LOG_LEVEL=info

# wget is available in node:22-alpine; used by the healthcheck
RUN addgroup -S eve && adduser -S eve -G eve \
 && mkdir -p /app/.eve-data \
 && chown -R eve:eve /app

WORKDIR /app

COPY --from=builder --chown=eve:eve /workspace/services/api-node/package.json ./package.json
COPY --from=builder --chown=eve:eve /workspace/services/api-node/server.mjs ./server.mjs
COPY --from=builder --chown=eve:eve /workspace/services/api-node/src ./src
COPY --from=builder --chown=eve:eve /workspace/services/api-node/node_modules ./node_modules

USER eve

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${API_PORT}/v1/health" >/dev/null || exit 1

CMD ["node", "server.mjs"]
