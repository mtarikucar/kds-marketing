# codex-media: codex app-server (ChatGPT image generation) behind a small HTTP API.
# Build:  docker build -t codex-media ./codex-media
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# The Codex CLI is pinned: app-server is "experimental" and its protocol changes between releases (§7).
ARG CODEX_VERSION=0.162.1
RUN npm install -g @openai/codex@${CODEX_VERSION} && npm cache clean --force \
 && groupadd --gid 10001 codex && useradd --uid 10001 --gid codex --create-home codex \
 && mkdir -p /home/codex/.codex /work && chown codex:codex /home/codex/.codex /work
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ENV NODE_ENV=production \
    CODEX_HOME=/home/codex/.codex \
    CODEX_MEDIA_WORK_DIR=/work \
    CODEX_MEDIA_HOST=0.0.0.0 \
    CODEX_MEDIA_PORT=7311
USER codex
EXPOSE 7311
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7311/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
