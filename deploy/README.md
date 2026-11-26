# Vessel Docker 部署（P1）

设计权威：`docs/dev/design/docker-cd-design.md` v2（多容器多角色）。本目录是 P1 交付的部署设施入口。
完整运维手册 `docs/operations/DOCKER.md` 随 P2 交付。

## 镜像（D11=A：一 Dockerfile 三 target → 三角色镜像，版本锁步、产物独立）

| 镜像 | target | 角色 | 容器内监听 | WebUI |
|---|---|---|---|---|
| `ghcr.io/egg-rolls/vessel-gateway` | `runtime-gateway` | 平台（WebUI+RPC+代理） | 0.0.0.0:8642（HTTP，TLS 由前置反代终结） | 有 |
| `ghcr.io/egg-rolls/vessel-node` | `runtime-node` | node 数据面（可多实例） | 0.0.0.0:8644（HTTPS，内部 CA） | 无 |
| `ghcr.io/egg-rolls/vessel-hub` | `runtime-hub` | 联邦 rendezvous | 0.0.0.0:8643（HTTPS，内部 CA） | 无 |

本地构建（三 target）：

```bash
docker build --target runtime-gateway -t vessel-gateway:dev .
docker build --target runtime-node    -t vessel-node:dev .
docker build --target runtime-hub     -t vessel-hub:dev .
# 共享 web/deps/runtime-base 层，增量缓存成本低；node/hub 不带 apps/web/dist。
```

## 三种部署形态

| 形态 | 文件 | 今天可跑？ | 说明 |
|---|---|---|---|
| **quick-start**（单容器） | `docker-compose.quickstart.yml` | ✅ 零证书零注册 | 一个 gateway 容器：隐式 node + 本地 hub，全回环。演示/试用/开发入口。 |
| **split-hub**（过渡多容器） | `docker-compose.split-hub.yml` | ✅ 零开发 | gateway（含隐式 node）+ 独立 hub 容器。证明 hub 维度独立打包/部署/卷分离今天成立。 |
| **主形态**（多容器骨架） | `docker-compose.yml` | ⚠️ 骨架 | gateway 薄壳 + node-1 + hub。**gateway↔node 跨容器注册需 G4（P2）**——node 注册表今天只接受 local（`node-registry.ts:25`）。node-1/hub 容器可独立起，gateway 代理/注册 node-1 待 G4。 |

> ★诚实能力边界（设计 §1.5）：今天零开发可跑的多容器形态是 **split-hub**；gateway/node 真分离 = G4 remote registry 开发项（P2，additive，2.x minor，不触 major）。

### quick-start

```bash
cd deploy
docker compose -f docker-compose.quickstart.yml up -d
docker compose -f docker-compose.quickstart.yml exec gateway vessel token show --purpose platform  # WebUI 导入
```

### split-hub

```bash
cd deploy
cp .env.example .env                 # 填 HUB_TOKEN（openssl rand -hex 32）+ HUB_JOIN_CODE + provider keys
bash certs/gen.sh                    # 内部 CA + hub 证书
mkdir -p config/gateway config/hub
cp config/gateway.example.yaml config/gateway/config.yaml   # ★不要创建 nodes.json（保留隐式 node）
cp config/hub.example.yaml config/hub/config.yaml
docker compose -f docker-compose.split-hub.yml up -d
docker compose -f docker-compose.split-hub.yml exec gateway vessel hub join https://hub:8643 --code "$HUB_JOIN_CODE"
docker compose -f docker-compose.split-hub.yml exec gateway vessel federation discover
```

### 主形态（G4 落地后全链路）

```bash
cd deploy
cp .env.example .env                 # NODE_1_TOKEN/HUB_TOKEN（openssl rand -hex 32）+ provider keys
bash certs/gen.sh
mkdir -p config/gateway config/node-1 config/hub
cp config/gateway.example.yaml config/gateway/config.yaml   # node-1/hub 同理
docker compose up -d
# G4（P2）后注册远程 node：
docker compose exec gateway vessel gateway nodes add node-1 --remote --url https://node-1:8644 --token-env NODE_1_TOKEN
```

证书生成/保管见 `certs/README.md`（D13）。角色配置示例见 `config/*.example.yaml`（不含密钥）。

## base image fallback（设计 §3.3 / §3.4）

Dockerfile runtime 底座钉 `oven/bun:1.4.4-slim`（D9 精确钉）。**slim 变体的 tag 存在性与内置 `bun` 用户（uid 1000）
在本实施环境无法在线核验**（Docker Hub egress 被墙 + 无 Docker daemon）。若用户环境 build 报
`unknown user bun` / `chown: invalid user` / manifest unknown，按以下 fallback 改 Dockerfile（deps 阶段同源）：

1. 改用完整 debian tag：`FROM oven/bun:1.4.4 AS runtime-base`（deps 阶段已用此 tag，确定存在）。
2. 或 `FROM node:22-bookworm-slim AS runtime-base` + 官方 bun 安装脚本钉 1.4.4：
   `RUN npm install -g bun@1.4.4`（或 `curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"`），并自建 uid 1000 用户。

## 用户环境验证命令（P1 首项实测，本环境不可达，候用户跑）

```bash
# 1) base image tag 存在性 + slim 内 bun 用户
docker manifest inspect oven/bun:1.4.4-slim
docker run --rm oven/bun:1.4.4-slim id bun          # 期望 uid=1000(bun)；若失败走上面 fallback

# 2) 三 target build 冒烟
docker build --target runtime-gateway -t vessel-gateway:dev .
docker build --target runtime-node    -t vessel-node:dev .
docker build --target runtime-hub     -t vessel-hub:dev .
docker run --rm vessel-gateway:dev --version        # 期望 = 根 package.json 版本（当前 2.1.0）
docker run --rm vessel-node:dev --version
docker run --rm vessel-hub:dev --version
# node/hub 镜像无 web dist：
docker run --rm --entrypoint sh vessel-node:dev -c 'test ! -e /app/apps/web/dist && echo NO_WEB_DIST_OK'

# 3) quick-start 全链路（30s 内 healthy；/health role=platform；非 root uid 1000）
cd deploy && docker compose -f docker-compose.quickstart.yml up -d
curl -fsS http://127.0.0.1:8642/health              # 期望 {"status":"ok","role":"platform",...}
docker compose -f docker-compose.quickstart.yml exec gateway id   # 期望 uid=1000(bun)
docker compose -f docker-compose.quickstart.yml down && docker compose -f docker-compose.quickstart.yml up -d
docker compose -f docker-compose.quickstart.yml exec gateway vessel token show --purpose platform  # down/up 后 token 不变

# 4) node/hub HEALTHCHECK 自签 CA 信任（NODE_EXTRA_CA_CERTS bun 支持性）
#    若 node/hub 容器恒 unhealthy 而服务实际正常 ⇒ bun fetch 不信任 CA，改 TCP 探活 fallback：
#    HEALTHCHECK CMD bun -e "require('net').connect(8644,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
#    （hub 同理改 8643）。或确认 bun 版本支持 NODE_EXTRA_CA_CERTS 后保留 https /health 探活。

# 5) 镜像卫生（无 .env / 宿主 node_modules / docs / examples / ca.key）
docker run --rm --entrypoint sh vessel-gateway:dev -c 'ls -a /app; test ! -e /app/.env && test ! -e /app/docs && echo HYGIENE_OK'
```

## 安全口径（不降级）

- 主形态仅发布 8642（D3）；node/hub 走内网 TLS + gateway 代理，不默认发布端口。
- 公网部署：ports 改 `"8642:8642"` + 前置 nginx/caddy **独立容器/主机**终结 TLS（bridge peer 非回环，天然避开同机反代 P0）；
  WebUI 公网必须导入平台 token + allowed_origins。不提供明文公网形态（设计 §8.5）。
- 密钥只走 env / 挂载，绝不进镜像（`.dockerignore` 排除 `.env`/`deploy`/数据目录）；`ca.key` 离线保管不进 git。