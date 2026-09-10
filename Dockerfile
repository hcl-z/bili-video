FROM node:24.18.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig*.json vite.config.ts components.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod

FROM node:24.18.0-bookworm-slim AS runtime

ARG YT_DLP_VERSION=2026.08.19
ARG YT_DLP_SHA256=1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    WEB_ROOT=/app/dist/web \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8788 \
    BILI_VIDEO_DOCKER=1 \
    LOG_JSON=1

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl ffmpeg python3 \
    && curl --fail --location --retry 3 \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" \
      --output /usr/local/bin/yt-dlp \
    && echo "${YT_DLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app app \
    && mkdir -p /app/data \
    && chown app:app /app/data

COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/src ./src
COPY --from=build --chown=app:app /app/dist ./dist

USER app

EXPOSE 8788
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8788/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "src/server/main.ts"]
