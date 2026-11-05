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

ENV NODE_ENV=production

# DejaVu fonts: PDF reports with Uzbek (oʻ, gʻ) and Russian text.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY company.md ./
COPY templates ./templates
COPY knowledge ./knowledge
COPY laws ./laws

# Runs as root on purpose: Railway mounts the volume at /app/data owned by root.
# Started with node directly (not npm) so SIGTERM from Railway reaches the bot.
CMD ["node", "dist/bot.js", "--settings-from-env"]
