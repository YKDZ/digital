# syntax=docker/dockerfile:1.7

ARG DEPLOYMENT_BUILD_ID="local"

FROM node:25-bookworm-slim AS base
# 与根 package.json 的 packageManager 保持一致：pruner 的 `pnpm fetch` 在 package.json 就位前
# 运行（用此激活版本），`pnpm install --offline` 在其后运行（corepack 读 packageManager）。
# 两者若跨 pnpm 主版本，fetch 写入的离线元数据命名空间与 install 读取的不兼容，报
# ERR_PNPM_NO_OFFLINE_META。统一为工作区声明的 pnpm@12.3.4 以保证同一版本与裁剪一致性。
ARG PACKAGE_MANAGER_PIN="pnpm@12.3.4"
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
# FANBOX production transport 与 package 中固定的 Playwright 版本共用同一 Chromium revision。
ENV PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"
RUN pnpm --filter @digital/fanbox exec playwright install chromium
# 由 Turbo 按正式 workspace 依赖图构建交付所需包，再由 deploy 在隔离的部署目录中定点
# 注入其发布文件。裁剪只决定包的存在，构建顺序与闭包由 Turbo 计算。
RUN TURBO_TELEMETRY_DISABLED=1 pnpm exec turbo run build \
  --filter=@digital/web --filter=@digital/db-migrations
RUN pnpm --config.inject-workspace-packages=true --filter ./apps/web deploy --prod /runtime-deploy
RUN pnpm --config.inject-workspace-packages=true --filter ./packages/db-migrations deploy --prod /migration-deploy

FROM node:25-bookworm-slim AS application-runtime
ARG DEPLOYMENT_BUILD_ID
LABEL org.opencontainers.image.version="$DEPLOYMENT_BUILD_ID"
ENV NODE_ENV="production" \
  DIGITAL_PRODUCT_DATA="/data" \
  PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin app \
  && install -d -o app -g nodejs /app /data
COPY --chmod=755 apps/web/scripts/compose-entrypoint.sh /usr/local/bin/compose-entrypoint
COPY --from=build --chown=app:nodejs /runtime-deploy/node_modules ./node_modules
COPY --from=build --chown=app:nodejs /repo/apps/web/dist ./dist
COPY --from=build /ms-playwright /ms-playwright
RUN node /app/node_modules/.pnpm/playwright@1.62.0/node_modules/playwright/cli.js install-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && chmod -R a-w /ms-playwright

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
