# syntax=docker/dockerfile:1
# Vessel — bun monorepo 源码镜像，三角色 target（D11=A：一 Dockerfile 三 target → 三角色镜像）。
# 设计：docs/dev/design/docker-cd-design.md v2 §3（镜像策略）/ §9（P1）。
# 版本对齐 release.yml / quality action：bun 1.4.4、Node 22。镜像内不跑 typecheck/biome（CD quality job 把关）。

# ── 阶段 1：Web 控制台（apps/web 不在 bun workspaces，独立 npm；build = tsc --noEmit && vite build）──
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build                      # → dist/（平台启动硬前置：缺 index.html 直接 exit 1）

# ── 阶段 2：workspace 生产依赖（bun monorepo：packages/* + plugins/*/*）──
FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# 整目录 COPY（不用通配扁平化）：bun 按 lock 链接 workspace:* → /app/packages/* 符号链接
COPY packages/ packages/
COPY plugins/ plugins/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

# ── 阶段 3：runtime 公共底座（/app 复刻仓库布局 = 零配置；非 root bun 用户）──
# 注意：oven/bun:1.4.4-slim 的 tag 存在性与 slim 内 bun 用户（uid 1000）为 P1 首项实测项
# （本环境 Docker Hub 被墙 + 无 daemon，候用户环境验）。fallback 见 deploy/README.md「base image fallback」：
# 改用完整 debian tag oven/bun:1.4.4（deps 阶段同源），或 node:22-slim + 官方安装脚本钉 1.4.4。
FROM oven/bun:1.4.4-slim AS runtime-base
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="https://github.com/egg-rolls/Vessel" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app ./
COPY package.json tsconfig.json ./     # tsconfig.json 必须随镜像（jsx: react-jsx）
COPY src/ src/
COPY skills/ skills/
# 不带仓库 vessel.yaml（D10：部署配置纯走挂载）；web dist 仅 gateway target 注入
RUN mkdir -p /data /home/bun/.vessel \
    && chown -R bun:bun /data /home/bun/.vessel \
    && chmod +x /app/src/cli.ts \
    && ln -s /app/src/cli.ts /usr/local/bin/vessel
USER bun
EXPOSE 8642 8643 8644
ENTRYPOINT ["bun", "/app/src/cli.ts"]

# ── 角色 target：gateway（带 WebUI；平台 0.0.0.0:8642，TLS 由前置反代终结）──
FROM runtime-base AS runtime-gateway
LABEL org.opencontainers.image.title="vessel-gateway"
COPY --from=web /web/dist apps/web/dist
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8642/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["gateway", "start", "--foreground", "--host", "0.0.0.0", "--data-dir", "/data"]

# ── 角色 target：node（无 WebUI；非回环三重门禁 allow_remote+TLS+token 走 config 挂载，避免 argv 泄密）──
# node start 缺省前台（--daemon 才分离）；/health 在 node 上一律开放免 token（node-supervisor.ts:353）
FROM runtime-base AS runtime-node
LABEL org.opencontainers.image.title="vessel-node"
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('https://127.0.0.1:8644/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "start", "--data-dir", "/data"]

# ── 角色 target：hub（无 WebUI；非回环三重门禁走 config 挂载）──
# hub start 前台（waitForStop）；/health 见 hub/server.ts:749
FROM runtime-base AS runtime-hub
LABEL org.opencontainers.image.title="vessel-hub"
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('https://127.0.0.1:8643/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["hub", "start", "--host", "0.0.0.0", "--data-dir", "/data"]

# node/hub HEALTHCHECK 的自签 CA 信任依赖 NODE_EXTRA_CA_CERTS（compose 注入 /certs/ca.crt）；
# bun 支持性为 P1 实测项，fallback：bun net.connect TCP 探活（见 deploy/README.md 验证节）。