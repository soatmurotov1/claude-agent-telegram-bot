# syntax=docker/dockerfile:1

# ---- Build stage: compile TypeScript ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:22-bookworm-slim

# Flags and builtin plugins were verified against this Claude Code version.
ARG CLAUDE_VERSION=2.1.303

ENV NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    PATH="/root/.local/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates bash \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}" \
    && claude --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY company.md ./

# Runs as root on purpose: Railway mounts the volume at /app/data owned by root.
# Started with node directly (not npm) so SIGTERM from Railway reaches the bot.
CMD ["node", "dist/bot.js", "--settings-from-env"]
