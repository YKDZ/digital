# syntax=docker/dockerfile:1.7

ARG DEPLOYMENT_BUILD_ID="local"

FROM node:24-bookworm-slim AS base
ARG PACKAGE_MANAGER_PIN="pnpm@11.23.0"
ENV COREPACK_HOME="/corepack"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
WORKDIR /repo
RUN install -d -m 0755 "$COREPACK_HOME" "$PNPM_HOME" \
  && corepack enable --install-directory "$PNPM_HOME" \
  && for attempt in 1 2 3; do \
    if corepack prepare "$PACKAGE_MANAGER_PIN" --activate; then break; fi; \
    [ "$attempt" -lt 3 ] || exit 1; \
    sleep 2; \
  done \
  && chmod -R a+rX "$COREPACK_HOME" "$PNPM_HOME"

FROM base AS pruner
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
# Web 的生产依赖闭包包含工作区包（尤其是 application）。在为 Turbo prune
# 提供冻结安装前，先向 pnpm 提供完整的工作区清单图。
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm exec turbo prune --scope=@digital/web --scope=@digital/db-migrations --docker

FROM base AS build
COPY --from=pruner /repo/out/json/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/json/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /repo/tsconfig.json /repo/tsconfig.config.json ./
RUN pnpm fetch
COPY --from=pruner /repo/out/json/ ./
RUN pnpm install --offline --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
COPY --from=pruner /repo/scripts/build-production-workspace.mjs ./scripts/build-production-workspace.mjs
# 先构建工作区依赖，再由 deploy 在隔离的部署目录中定点注入其发布文件。
RUN node scripts/build-production-workspace.mjs
RUN pnpm --config.inject-workspace-packages=true --filter ./apps/web deploy --prod /runtime-deploy
RUN pnpm --config.inject-workspace-packages=true --filter ./packages/db-migrations deploy --prod /migration-deploy

FROM node:24-bookworm-slim AS application-runtime
ARG DEPLOYMENT_BUILD_ID
LABEL org.opencontainers.image.version="$DEPLOYMENT_BUILD_ID"
ENV NODE_ENV="production" \
  DIGITAL_PRODUCT_DATA="/data"
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin app \
  && install -d -o app -g nodejs /app /data
COPY --chmod=755 apps/web/scripts/compose-entrypoint.sh /usr/local/bin/compose-entrypoint
COPY --from=build --chown=app:nodejs /runtime-deploy/node_modules ./node_modules
COPY --from=build --chown=app:nodejs /repo/apps/web/dist ./dist

# 仅启动部署刻意不携带迁移 CLI、迁移 SQL 或准备入口。未准备的数据卷必须拒绝
# readiness，而不是自行迁移。
FROM application-runtime AS runtime
USER app
EXPOSE 3000
CMD ["node", "/app/dist/server/index.mjs"]

# 组合部署是唯一携带正式准备能力的镜像。
FROM application-runtime AS standalone
COPY --from=build --chown=app:nodejs /migration-deploy /migration
COPY --chmod=755 apps/web/scripts/container-entrypoint.sh /usr/local/bin/container-entrypoint
USER app
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/container-entrypoint"]
CMD ["prepare-and-start"]
