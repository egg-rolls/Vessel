---
title: 跨机器远程运维
kind: current
triggers: [远程, 远程运维, 远程访问, 跨机器, 多机部署, 证书, CA, TLS, 令牌, 非回环, 安全边界, hub, 联邦, 出站]
paths: [docs/operations/REMOTE.md]
---

# 跨机器远程运维

> 状态：Platform Gateway / Node API 拆分、本地多 Node 与 Hub 出站加入均已实现并合入主线；
> 当前版本与发布状态以 [docs/versions/CURRENT.md](../versions/CURRENT.md) 为准。0.11 起 Web 控制台
> 壳层支持 zh-CN / en。决策边界见 [ADR-051](../adr/ADR-051-remote-control-plane.md) /
> [ADR-052](../adr/ADR-052-cross-node-transport.md) / [ADR-053](../adr/ADR-053-remote-security-baseline.md) /
> [ADR-101](../adr/ADR-101-platform-gateway-and-node-api.md)。
> 架构细节见 [gateway.md](../architecture/gateway.md#protocol)、[#tls](../architecture/gateway.md#tls)、
> [#remote](../architecture/gateway.md#remote) 与 [federation-hub.md](../architecture/federation-hub.md)。

本文覆盖：证书与 CA、两机配置、独立前端部署、故障排查与安全边界。
默认行为不变：Platform Gateway 绑 `127.0.0.1:8642`、Node API 绑 `127.0.0.1:8644`、明文；
远程与 Hub 出站都必须显式 opt-in。一个 node 服务一个公司，没有 tenant 选择或覆盖。

## 1. 安全边界

- **非回环 fail-closed**：非回环访问必须同时具备 **token** 与 **HTTPS/WSS**；缺一即失败，不回退匿名或明文。
- **无逃生口**：不提供 `--insecure` / `-k` / “忽略证书错误”；失败信息区分 token 401、Origin 403、TLS 校验失败与网络错误。
- **token 不进 URL**：WS 首帧 `{ kind: 'auth', token, since? }`；HTTP 用 `Authorization: Bearer`。token 不写入日志。
- **Origin allowlist**：`serve.allowed_origins` 只接受显式 `http(s)://host[:port]`，拒绝 `*`、path、query；HTTP 与 WS upgrade 共用同一 allowlist。命中时返回 CORS 头并带 `Vary: Origin`，永不使用 `Access-Control-Allow-Credentials`。
- **浏览器凭据**：Web token 只放 `sessionStorage`（独立前端可用 `#token=` 首次导入）；不写 `localStorage`、不进 query。
- **per-node token**：Platform Gateway 的 `gateway.token` / `gateway.token_env` 与 Node API 的 `serve.token(s)` / `serve.token_env` 分开，互不回退；远端 `--connect` 使用节点 token。`serve.tokens` 条目只含 `role`，不带 tenant。
- **单公司**：一个 node 恰好一份执行面、一条事件流；数据直接位于 `<dataDir>/**`（`sessions` / `runs` / `events` / `agents` 等），没有 `tenants/<id>` 层；principal 由 token 决定（`role: read | write | admin`），没有跨 tenant 读取或 `forbidden` 语义。
- **信任边界**：`node_id` 以 token + TLS 边界信任，没有逐事件签名；不要通过不可信第三方转发同 Origin 的节点事件。
- **不在 0.6 范围**：mTLS / 客户端证书、HTTP/2、ACME / 自动续期、反向代理信任头、mDNS / 服务网格 / 节点自动发现。

### 1.1 0.6.1 的安全收紧

> 以下收紧在 0.6.1 已实现。

- **durable 端点**：`/v1/durable/*` 接收 token principal；list 返回该 node 的 run（单公司，不再按 tenant 过滤）；resume 要求 `write` 及以上。
- **远端 spawn（0.6.1 行为，已随 0.17 删除）**：当时复用 `buildChildHost`（剔除 `team_*`）并传入成员限额；0.17 起成员生命周期只走 `packages/agent`，跨节点写路径留待 Phase B。

## 2. 证书与 CA

### 2.1 服务端证书

非回环 Node API 必须提供 PEM 格式的 cert/key，且成对、文件非空：

```yaml
serve:
  hostname: 0.0.0.0
  port: 8644
  allow_remote: true
  tls:
    cert_file: /etc/vessel/node-b-cert.pem
    key_file: /etc/vessel/node-b-key.pem
```

等价 CLI：`vessel node start --config <path>` 读取上述配置；legacy `--serve` 仍可用但只起单监听 8642。
证书的 SAN 必须包含客户端实际使用的 host / IP（浏览器与 Node 客户端都会校验证书链）。自签示例：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout node-b-key.pem -out node-b-cert.pem \
  -subj "/CN=node-b.example.com" \
  -addext "subjectAltName=DNS:node-b.example.com,IP:192.168.1.20"
```

> 证书与私钥属于部署凭据，不要提交到仓库；权限至少 `0600`。0.6 不做自动轮换，过期后连接会直接失败。

### 2.2 客户端 CA

- **CLI / TUI / headless**：`--ca <ca.pem>` 或 `connect.ca_file` 显式提供私有 CA / 自签证书；未提供时使用运行时默认信任库。
- **浏览器**：无法按连接指定 CA 文件，必须把 CA 装进操作系统 / 浏览器的信任库；否则独立前端会报证书错误。

```yaml
connect:
  ca_file: /etc/vessel/ca.pem
```

## 3. 两机配置

以下示例：`node-a` 是父端（本地 Platform Gateway 与客户端），`node-b` 是远端 node。
跨节点 team 模型工具已在 0.17 删除，保留的 federation 只是传输协议。

### 3.1 node-b：暴露 Node API

```yaml
# ~/.vessel/config.yaml（node-b）
host:
  node_id: node-b

serve:
  hostname: 0.0.0.0
  port: 8644
  allow_remote: true
  token_env: VESSEL_NODE_TOKEN
  tls:
    cert_file: /etc/vessel/node-b-cert.pem
    key_file: /etc/vessel/node-b-key.pem

# 平台监听与 node token 分开；仅需要本机 UI / platform RPC 时配置
gateway:
  hostname: 127.0.0.1
  port: 8642
  token_env: VESSEL_PLATFORM_TOKEN
```

```bash
# node-b：独立 Node API（前台；daemon 加 --daemon）
export VESSEL_NODE_TOKEN='<node-b-token>'
vessel node start --config /etc/vessel/node-b.yaml
```

要点：

- `host.node_id` 必须唯一；federation peer 的 `node_id` 必须与它一致。
- 非回环必须 `allow_remote: true` + token + TLS；否则启动失败。
- 节点 token 可用 `serve.tokens` 分角色（只含 `role`）：

```yaml
serve:
  tokens:
    "<node-b-read-token>": { role: read }
    "<node-b-write-token>": { role: write }
```

### 3.2 node-a：远程客户端

```yaml
# ~/.vessel/config.yaml（node-a）
connect:
  token_env: VESSEL_CONNECT_TOKEN
  ca_file: /etc/vessel/ca.pem
```

```bash
# node-a
export VESSEL_CONNECT_TOKEN='<node-b-token>'
vessel --connect https://node-b.example.com:8644 \
  --ca /etc/vessel/ca.pem --run "hello"
```

- token 优先级：`--connect-token` > env（`VESSEL_CONNECT_TOKEN` 或 `connect.token_env`）> `connect.token`。
- `--connect` / `VESSEL_CONNECT` 只接受 origin；回环允许 `http://`，非回环必须是 `https://`。
- 建连后 `health.get` 取远端 node 身份；CLI 在 stderr 打印 `Remote gateway: node=...`。
- connect 模式不获取本地 data-dir 写意图锁，也不写本地 store / trace。

### 3.3 跨节点 agent 传输（0.22.1 已删除）

0.6 的 `transport.kind: loopback|remote`、`transport.nodes[]`、`LoopbackTransport`、
`RemoteTransport`、`NodeRegistry` 与 gateway `/v1/team/*` 已于 0.22.1 删除；
`transport.kind` 现在只接受 `in-process`。跨节点投递使用 federation
（`POST /v1/federation/messages`，见 `docs/versions/0.20.0.md` 与 [ADR-094](../adr/ADR-094-federation-team-to-team.md)），
远程客户端 / `--connect` 的用法不变。

### 3.3.1 Federation 与成员寻址（0.21）

- 地址 `<principal>@<node_id>:<team_id>`；`principal` 是目标 Team 的 present 成员名或保留字 `human`。三段字符集互斥，按最后一个 `@` 与其中唯一 `:` 解析。
- wire 的 `from` / `to` 为 `{ node_id, team_id, principal }`；principal 是名字，不是 agent id。
- 入站按 `to.principal` 单点投递：`human` → 日志 + owner，0 run；成员 → 先写 mention 日志再 dispatch 给一个人。解析用完整 roster，private / left / closed / 不存在 / 重名 → 404，零写入。
- `accept` 只接受 `'principal'`（缺省）与 `'log'`；`'members'` 是显式错误，非法值 fail-safe 为 `log`。每 peer 限流 `federation.rateLimitPerMinute`（1..600，缺省 60，超限 429）。
- hop = 1、无中继、无离线队列、无跨重启 exactly-once。

### 3.4 Node / Gateway 生命周期与热重载（0.12，0.49 拆分）

```bash
# 平台 + 本地 node（同进程双监听）；每个 auto_start 本地 node 为子进程
vessel gateway start [--daemon]
vessel gateway nodes list [--json]
vessel gateway nodes add <name> --data-dir <dir> --config <path> [--no-auto-start]
vessel gateway nodes remove <name>
vessel gateway status [--json]
vessel gateway reload [--scope config,plugins]
vessel gateway stop [--timeout 10s]

# 只操作 Node API
vessel node start [--daemon] [--config <path>]
vessel node status [--json] [--rpc]
vessel node reload [--scope config,plugins]
vessel node stop
```

- `gateway start`：Platform Gateway 缺省 `127.0.0.1:8642`（UI / 静态宿主 / `/platform/rpc` 只读 allowlist）+ Node API 缺省 `8644`（`/v1/*`、WS/SSE、插件 HTTP）。两者认证链与路由表分离。`hub.auto_start`（默认 true）时同时拉起本地 Hub 8643；已有实例 adopt，Web Hub 页回环自动连接。
- `vessel node start --config <path>`：用独立配置启动 standalone Node API；`gateway nodes add` 把本地 node 写入 `nodes.json`（0600 原子写，不含 token），`auto_start` 节点由 gateway 拉起。
- 运行态以 `<dataDir>/gateway.pid`（node，G1 兼容名）与 `<dataDir>/platform.pid`（平台）为准，均 `0600`；daemon 日志在 `<dataDir>/logs/`。`status --json` 只输出 JSON。
- 修改 TLS 证书、token、端口或 provider / model 后必须 `restart`；`reload` 会在 `requires_restart` 中列出这些字段，不能把 reload 成功当成新证书 / 新 token 已生效。
- 跨 Origin 的 `serve.allowed_origins` 是少数可热更新项：改配置后执行 `vessel gateway reload --scope config`（或 `node reload`）即可，无需重启。token 仍在配置解析时读取，热重载不替换已建立的鉴权状态。
- PID 文件与 daemon 日志权限为 `0600`；节点升级用 `vessel update`（npm / bun 全局安装）或 `--check` 仅检查；源码部署只提示 `git pull && bun install`。
- 常驻与开机自启交给 `install-service`（当前平台的用户级服务）；daemon 自身不做崩溃重启。

### 3.5 远程权限交互与本地状态栏（0.13）

- **权限等待默认不超时**：远程客户端不点击时权限请求会一直保留，直到应答、取消或 run abort；不要用固定超时清理 pending。`expired` 只在请求确已过期时返回，`run_ended` 表示 run 已结束或记录已 `orphaned`。
- **持久化**：gateway 在 `<dataDir>/interactions-<id>.json` 记录 `pending` / `answered` / `orphaned`（`0600` 原子写，`<id>` 为持久化单 id）。命名实例写 `<dataDir>/instances/<instance>/interactions-<id>.json`。重启后旧 `pending` 转 `orphaned`，迟到应答返回 `run_ended`；重复应答幂等，不同决定返回 `conflict`。多端连接同一 gateway 时共享这份状态。
- **独立前端**：权限卡片内联在所属 run，跨 session 的待处理请求在顶部条提示；其他端应答 / 过期 / run 终态会自动收起卡片。`ask` 同样内联在所属 run，默认无限等待，由应答 / abort / run 终态收口。
- **TUI 状态栏**：`Ctrl+T` / `Ctrl+G` 切换上 / 下栏，`Ctrl+R` 打开 `/resume`；显隐写回用户配置 `ui.statusBars`（YAML `status_bars`）。`VESSEL_STATUS_BARS` 只作启动初值，不随远程连接或手动切换改变。终端 `<40` 列不渲染下栏，`<18` 行默认隐藏。

### 3.5.1 人类控制 token 词表（0.22）

| 词 | 认证谁 | 用途 |
|---|---|---|
| `gateway token` | 用户 / 管理员 | Platform Gateway `/platform/rpc` 与 UI |
| `node token` | 用户 / 管理员 | Node API canonical RPC / WS |
| `team token`（team-scoped control） | 限定 team 的用户 | 只能操作自己的 team |
| `owner token` | 本机 REPL owner | 本机 owner 端点，loopback |
| `peer token` | 节点 | `/v1/federation/*`，不能答权限 |
| `hub token` | hub / node | hub 目录 / 控制面 |

- 文档 / CLI help / 错误消息不再使用裸 “token”。
- permission / ask 只在运行 agent 的节点本地应答；peer token 不能用于 `interactions.list` / `permission.respond` / `ask.respond`；`answered_by` 只接受 `human | policy`，`answered_via: 'cli'` 只是审计提示。

### 3.6 Hub 控制面（独立进程）

Hub 是**独立前台目录进程**（`vessel hub start`），不在 gateway 内，也不随 gateway 启动；节点执行与浏览器直连不受它影响。控制面只保留 **node → hub** 出站方向。

```bash
# hub 侧（独立 dataDir，必须与节点 dataDir 不同）
vessel hub start --data-dir /srv/vessel-hub --host 127.0.0.1 --port 8643
vessel hub join-code --data-dir /srv/vessel-hub --ttl 300 --json
vessel hub directory --hub-url https://hub.example:8643 --json
vessel hub node list --hub-url https://hub.example:8643 --json
vessel hub node remove <pairing_id> --hub-url https://hub.example:8643

# node 侧：用一次性 code 出站加入，token 只进 SecretStore
vessel hub join https://hub.example:8643 --code <CODE> \
  [--public-url <url>] [--ca <file>] [--data-dir <nodeDir>] [--json]
```

- 一次性 join code 默认 300 秒、只存 `sha256`；hub 签发 `scope: node` token，只用于 WSS `/v1/hub/node-control`，绑定 `hub_id` / `node_id`，不进入 canonical RPC 或 `PrincipalScope`。
- 节点侧非秘密状态（`hub_url` / `hub_id` / `node_id` / `pairing_id` / `token_id` / `expires_at`）写 gateway data dir 的 `hub-node.json`（0600），运行状态写 `hub-node-status.json`；**明文 node token 只进 SecretStore**，不写 YAML / JSON / 日志。hub 侧 `<hubDataDir>/hub-join.json` 与 `<hubDataDir>/node-tokens.json` 都只存 `sha256`。
- 目录主键 `pairing_id = node_id`；hub 只维护目录并推送 `{node_id, team_id, request_id?, reason, ts}` 指针；消息、事件、工具结果与权限正文**始终由浏览器直连节点**，hub 不代理、不落盘。
- **一个 node 进程 / data dir 只加入一个 hub**；多 hub 需要多个 data dir / 进程。离开 = 删除 `hub-node.json`（及 SecretStore 条目）。
- **NAT 数据面**：出站只保证控制面元数据 / 指针。除非节点有浏览器可达地址（隧道 / 反向代理）并声明 `public_url`，否则正文（聊天、事件、工具结果、权限）不可达；目录的 `data_plane: direct|unreachable` 由 `public_url ?? url` 派生。hub 不中继正文。
- 吊销：`vessel hub node remove <pairing_id>` 关闭该节点的控制 WS、吊销 token hash、删目录记录；旧 token 重连返回 4401，节点需重新 `hub join`。
- 旧 hub → node 拨号、节点入站路由、`hub pair` / `hub node add` / `hub token *` / `hub data-token` 已删除；调用会失败并提示改用 `hub join-code` / `hub join`。

## 4. 独立前端部署

```bash
cd apps/web
npm ci
npm run build            # 产物在 apps/web/dist
```

把 `dist/` 部署到任意静态站点（例如 `https://console.example.com`），然后：

1. 服务端加入该 Origin：浏览器直连 node 时改 `serve.allowed_origins`；页面由 Platform Gateway 托管时改 `gateway.allowed_origins`（或启动时重复 `--allowed-origin https://console.example.com`）。
2. 浏览器信任 node 证书（自签 CA 装入系统 / 浏览器信任库）。
3. 打开页面后设置 node 地址：
   - 运行时优先级：`localStorage['vessel.gateway-url']` > `VITE_GATEWAY_URL` > 同源；
   - 只接受 `http(s)://host[:port]`，非回环必须 `https`；
   - HTTPS 页面不能连接 `http://` node（mixed content 会被浏览器拦截）。
4. 首次用 `#token=<node-token>` 导入 token；token 随后只存 `sessionStorage`。
5. **界面语言**（0.11）：Web 壳层与 Settings 支持 zh-CN / en。初始 locale 取 `localStorage['vessel.ui.language']` > `navigator.language`，可在 Settings → Appearance 切换并立即生效；未收录的功能页回退中文。语言选择存本地，不影响 gateway。

独立静态站点需要自行下发 CSP，至少允许连接目标 Node API：

```text
connect-src 'self' https://node-b.example.com:8644 wss://node-b.example.com:8644
```

Platform Gateway 同源托管 `dist` 时不需要 `allowed_origins`，CSP 由平台按 Host / allowlist 生成。

## 5. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| HTTP 401 `unauthorized` | token 缺失 / 错误 / 未映射 | 检查 `--connect-token`、`VESSEL_CONNECT_TOKEN`、`connect.token_env`、`serve.tokens` |
| HTTP 403 `forbidden` | Origin 不在 allowlist，或 token role 不足 | 加 `serve.allowed_origins`；确认 token 的 `role` |
| WS 关闭 4401 | 首帧 `auth` 缺失或超过 5s | 确认客户端版本；token 不能放 URL |
| `data_locked` | 本地写意图命令（`migrate --apply` / `trace prune` / `eval`）遇到同一 dataDir 的另一写者 | 停掉占用进程；不要删除活跃锁；或改用 `--connect` |
| `non_root_layout` | 存在非空 `<dataDir>/tenants/**` 或 `.t2-migrating-*` | 先归档旧数据，再在根布局启动；命令不迁移、不删除 |
| TLS 校验失败 | 未提供 CA、SAN 不匹配、证书过期 | 用 `--ca` / `connect.ca_file`；重签含正确 SAN 的证书 |
| 浏览器证书错误 | 系统 / 浏览器未信任 CA | 把 CA 装入信任库；不能按连接指定 CA |
| mixed content | HTTPS 页面连 `http://` node | node 改用 HTTPS |
| 连接成功但不断 `gap` | 事件缓冲被截断（默认 10000） | 客户端按 `to_seq` 带 `since` 重连；降低事件速率或调用方自建持久化 |

## 6. 已知限制

- 无全局事件序、无分布式锁、无跨机 durable、无跨机编排；一个 node 只服务一个公司、一条事件流。
- `request_id` 去重是进程内 Map，不跨重启；同 key 不同参数返回首次结果。
- 跨节点 agent 传输面（`/v1/team/*` / `RemoteTransport` / `NodeRegistry` / loopback transport）已于 0.22.1 删除；跨节点投递只有 federation。
- Hub 只做目录与指针：node → hub 出站已支持（NAT），但跨节点 A2A、多 hub 联邦、远程管理 hub、hub daemon / 系统服务注册仍未实现；NAT 正文数据面需隧道 / 反向代理。
- 监听 `0.0.0.0` 时 banner / `hello.node.endpoint` 仍显示 `http://0.0.0.0:<port>`；实际访问需换成真实 IP / 域名（并匹配证书 SAN）。
- `--connect-token` 会出现在进程参数列表中；生产优先用 env 或文件权限受控的 config。
- 多 node 场景下 `gateway reload` / `agents` 仍走全局 node 监听默认 8644；需要按节点操作时用 `node reload` / 直连该 node。

## 7. 验证清单

```bash
# 1. 证书与健康探针（不要用 -k）
curl --cacert /etc/vessel/ca.pem https://node-b.example.com:8644/health

# 2. 远程客户端
VESSEL_CONNECT_TOKEN='<token>' vessel \
  --connect https://node-b.example.com:8644 \
  --ca /etc/vessel/ca.pem --run "hello"

# 3. 跨节点 agent 传输已于 0.22.1 删除；验证 federation 见 docs/versions/0.20.0.md 与 ADR-094

# 4. 离线门禁（仓库无自动化测试套件：typecheck + biome + check-* 脚本 + 一条端到端烟测）
bun run typecheck
bunx @biomejs/biome ci .
bun run scripts/check-config-sources.ts
bun run scripts/check-trace.ts
VESSEL_MOCK=1 bun run src/cli.ts --run "hello"
```
