# 跨机器远程运维（0.6）

> 状态：F5 跨机器远程与跨节点 team **已合入 `release/0.6`（未发布）**；0.11 起 Web 控制台壳层支持 zh-CN / en。
> 决策边界见 [ADR-051](../adr/ADR-051-remote-control-plane.md) /
> [ADR-052](../adr/ADR-052-cross-node-transport.md) /
> [ADR-053](../adr/ADR-053-remote-security-baseline.md)。
> 架构细节见 [ARCHITECTURE.md §13.1 / §13.5.1 / §13.8](../ARCHITECTURE.md)。

本文覆盖：证书与 CA、两机配置、独立前端部署、故障排查与安全边界。
默认行为不变：gateway 只绑 `127.0.0.1:8642`、明文；远程与跨节点都必须显式 opt-in。

## 1. 安全边界

- **非回环 fail-closed**：非回环访问必须同时具备 **token** 与 **HTTPS/WSS**；缺一即失败，不回退匿名或明文。
- **无逃生口**：不提供 `--insecure` / `-k` / “忽略证书错误”；失败信息区分 token 401、Origin 403、TLS 校验失败与网络错误。
- **token 不进 URL**：WS 首帧 `{ kind: 'auth', token, since? }`；HTTP 用 `Authorization: Bearer`。token 不写入日志。
- **Origin allowlist**：`serve.allowed_origins` 只接受显式 `http(s)://host[:port]`，拒绝 `*`、path、query；HTTP 与 WS upgrade 共用同一 allowlist。命中时返回 CORS 头并带 `Vary: Origin`，永不使用 `Access-Control-Allow-Credentials`。
- **浏览器凭据**：Web token 只放 `sessionStorage`（独立前端可用 `#token=` 首次导入）；不写 `localStorage`、不进 query。
- **tenant**：远端 tenant 由 token principal 派生；admin 可用 `--tenant` 覆盖，非 admin 指定其它 tenant → `forbidden` / WS 4403。跨节点 team 控制面当前 **default/admin-only**。
- **信任边界**：`node_id` 以 token + TLS 边界信任，没有逐事件签名；不要通过不可信第三方转发同 Origin 的节点事件。
- **不在 0.6 范围**：mTLS / 客户端证书、HTTP/2、ACME / 自动续期、反向代理信任头、mDNS / 服务网格 / 节点自动发现。

### 1.1 0.6.1 的安全收紧

> 以下收紧在 0.6.1 已实现。

- **durable 端点**：`/v1/durable/*` 接收 token principal；list 只返回当前 tenant 的 run；非 default tenant 且没有 per-tenant store 时返回 `forbidden`；resume 要求 `write` 及以上。
- **team REST 角色**：复用 `ROLE_RANK`；`GET /v1/team/*` 允许 `read`，spawn / send / cancel / close 要求 `write` / `admin`。default tenant 的只读 token 不再能变更 team。
- **跨节点事件**：回灌时丢弃 `event.node_id === 本机 node_id` 的帧；双向 / 网状拓扑不再回声放大。静态节点表仍建议按单向父端订阅配置。
- **远端 spawn**：复用 `buildChildHost`（剔除 `team_*`），并传入 `memberLimits` / `memberTermination`，与本机 spawn 的隔离和限额一致。

## 2. 证书与 CA

### 2.1 服务端证书

非回环 gateway 必须提供 PEM 格式的 cert/key，且成对、文件非空：

```yaml
serve:
  tls:
    cert_file: /etc/vessel/node-b-cert.pem
    key_file: /etc/vessel/node-b-key.pem
```

等价 CLI：`--tls-cert node-b-cert.pem --tls-key node-b-key.pem`。

证书的 SAN 必须包含客户端实际使用的 host / IP（浏览器与 Node 客户端都会校验证书链）。自签示例：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout node-b-key.pem -out node-b-cert.pem \
  -subj "/CN=node-b.example.com" \
  -addext "subjectAltName=DNS:node-b.example.com,IP=192.168.1.20"
```

> 证书与私钥属于部署凭据，不要提交到仓库；权限至少 `0600`。0.6 不做自动轮换，过期后连接会直接失败。

### 2.2 客户端 CA

- **CLI / TUI / headless**：`--ca <ca.pem>` 或 `connect.ca_file` 显式提供私有 CA / 自签证书；未提供时使用运行时默认信任库。
- **跨节点 transport**：每个节点可用 `transport.nodes[].ca_file` 指定该节点的 CA。
- **浏览器**：无法按连接指定 CA 文件，必须把 CA 装进操作系统 / 浏览器的信任库；否则独立前端会报证书错误。

```yaml
connect:
  ca_file: /etc/vessel/ca.pem
```

## 3. 两机配置

以下示例：`node-a` 是父端（跑 team / 发起跨节点调度），`node-b` 是远端执行节点。

### 3.1 node-b：暴露 TLS gateway

```yaml
# ~/.vessel/config.yaml（node-b）
host:
  node_id: node-b

serve:
  hostname: 0.0.0.0
  port: 8642
  allow_remote: true
  # default tenant + admin 的单 token 兼容写法；生产建议用 serve.tokens
  token_env: VESSEL_GATEWAY_TOKEN
  tls:
    cert_file: /etc/vessel/node-b-cert.pem
    key_file: /etc/vessel/node-b-key.pem
  # 只有独立前端需要；同源访问可省略
  allowed_origins:
    - https://console.example.com

team:
  enabled: true
```

```bash
# node-b
export VESSEL_GATEWAY_TOKEN='<node-b-token>'
bun run src/cli.ts --serve 8642 --serve-host 0.0.0.0 --allow-remote \
  --tls-cert /etc/vessel/node-b-cert.pem \
  --tls-key /etc/vessel/node-b-key.pem
```

要点：

- `host.node_id` 必须唯一，且与父端 `transport.nodes[].id` 一致。
- 非回环必须 `allow_remote: true` + token + TLS；否则启动失败。
- 跨节点 team 的 token 必须映射到 **default tenant** 或 **admin**；非 default tenant 的 token 调用 team 控制面返回 403。
- 多租户部署可用 `serve.tokens`：

```yaml
serve:
  tokens:
    "<node-b-default-token>": { tenant_id: default, role: write }
    "<node-b-admin-token>": { tenant_id: "*", role: admin }
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
bun run src/cli.ts --connect https://node-b.example.com:8642 \
  --ca /etc/vessel/ca.pem --run "hello"
```

- token 优先级：`--connect-token` > env（`VESSEL_CONNECT_TOKEN` 或 `connect.token_env`）> `connect.token`。
- `--connect` / `VESSEL_CONNECT` 只接受 origin；回环允许 `http://`，非回环必须是 `https://`。
- 建连后 `health.get` 取远端 tenant / node；CLI 在 stderr 打印 `Remote gateway: node=... tenant=...`。
- admin 可用 `--tenant <id>` 显式覆盖；非 admin 指定其它 tenant 会被拒绝。
- connect 模式不获取本地 tenant 写锁，也不写本地 store / trace。

### 3.3 node-a：跨节点 transport 与 team

```yaml
# ~/.vessel/config.yaml（node-a）
host:
  node_id: node-a

team:
  enabled: true

transport:
  kind: remote
  nodes:
    - id: node-b
      url: https://node-b.example.com:8642
      token_env: NODE_B_TOKEN
      ca_file: /etc/vessel/ca.pem
```

```bash
export NODE_B_TOKEN='<node-b-token>'
VESSEL_MOCK=1 bun run src/cli.ts   # team_* 工具在 team.enabled: true 时注册
```

工具用法（5 个 `team_*` 只增加可选 `node`，协议不变）：

```text
team_spawn  { "node": "node-b", "name": "worker" }
team_status { "node": "node-b" }                  # 列出远端节点成员
team_status { "member": "node-b:worker" }         # 查看远端成员
team_send   { "to": "node-b:worker", "kind": "task", "content": "..." }
team_inbox  { "member": "node-b:owner", "cursor": "..." }
team_cancel { "member": "node-b:worker" }
```

- 成员地址支持 `node:agent`；不带 node 前缀时按本机处理。
- 节点心跳：`GET /v1/team/agents`（失败回退 `/health`），默认 5s；状态 `healthy` / `unreachable`，展示 TTL 15s。
- 跨节点事件：父端订阅 `wss://<node>/v1/events`，按 `node:incarnation:run_id:seq` 去重后回灌（无 `run_id` 写 `-`；对端 `incarnation` 变化或 seq 回退只清该来源节点的键）。`seq` 按 `(node_id, run_id)` 解释，没有全局序；去重集合只在进程内，不跨重启。

## 4. 独立前端部署

```bash
cd apps/web
npm ci
npm run build            # 产物在 apps/web/dist
```

把 `dist/` 部署到任意静态站点（例如 `https://console.example.com`），然后：

1. 服务端在 `serve.allowed_origins` 加入该 Origin（或启动时重复 `--allowed-origin https://console.example.com`）。
2. 浏览器信任 gateway 证书（自签 CA 装入系统 / 浏览器信任库）。
3. 打开页面后设置 gateway 地址：
   - 运行时优先级：`localStorage['vessel.gateway-url']` > `VITE_GATEWAY_URL` > 同源；
   - 只接受 `http(s)://host[:port]`，非回环必须 `https`；
   - HTTPS 页面不能连接 `http://` gateway（mixed content 会被浏览器拦截）。
4. 首次用 `#token=<token>` 导入 token；token 随后只存 `sessionStorage`。
5. **界面语言**（0.11）：Web 壳层与 Settings 支持 zh-CN / en。初始 locale 取 `localStorage['vessel.ui.language']` > `navigator.language`，可在 Settings → Appearance 切换并立即生效；未收录的功能页回退中文。语言选择存本地，不影响 gateway。

独立静态站点需要自行下发 CSP，至少允许连接目标 gateway：

```text
connect-src 'self' https://node-b.example.com:8642 wss://node-b.example.com:8642
```

gateway 同源托管 `dist` 时不需要 `allowed_origins`，CSP 由 gateway 按 Host / allowlist 生成。

## 5. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| HTTP 401 `unauthorized` | token 缺失 / 错误 / 未映射 | 检查 `--connect-token`、`VESSEL_CONNECT_TOKEN`、`connect.token_env`、`serve.tokens` |
| HTTP 403 `forbidden` | Origin 不在 allowlist，或 tenant 不匹配 | 加 `serve.allowed_origins`；非 admin 不要跨 tenant |
| WS 关闭 4401 | 首帧 `auth` 缺失或超过 5s | 确认客户端版本；token 不能放 URL |
| WS 关闭 4403 | 非 admin 指定其它 tenant | 用 token principal 的 tenant，或改用 admin token |
| TLS 校验失败 | 未提供 CA、SAN 不匹配、证书过期 | 用 `--ca` / `connect.ca_file`；重签含正确 SAN 的证书 |
| 浏览器证书错误 | 系统 / 浏览器未信任 CA | 把 CA 装入信任库；不能按连接指定 CA |
| mixed content | HTTPS 页面连 `http://` gateway | gateway 改用 HTTPS |
| 连接成功但不断 `gap` | 事件缓冲被截断（默认 10000） | 客户端按 `to_seq` 带 `since` 重连；降低事件速率或调用方自建持久化 |
| `peer_unreachable` / `timeout` | 节点不可达、URL / 防火墙错误 | `curl --cacert ca.pem https://<node>/health`；检查 `transport.nodes[].url` 与端口 |
| `peer_not_found` | 目标 node id 不在静态表 | 检查 `transport.nodes[].id` 与 `node:agent` 前缀 |
| `no_spawn` | 远端 gateway 没有 spawn 处理器 | 远端 `team.enabled: true` 且 gateway 装配了 team |
| `/health` 显示 healthy 但 team 调用失败 | `/health` 只是兜底探针 | 以 `/v1/team/agents` 与实际调用为准 |
| spawn 返回首次结果 | `request_id` 进程内去重（上限 1000） | 每次新 spawn 用新的 `request_id`；去重不跨重启 |

## 6. 已知限制

- 无全局事件序、无分布式锁、无跨机 durable、无跨机 workflow 编排；workflow / 飞书控制面仍只走 default tenant。
- `request_id` 去重是进程内 Map，不跨重启；同 key 不同参数返回首次结果。
- `spawn` 不自动重试；`status` / `inbox` 超时或不可达最多幂等重试一次；结果回投失败只发 `team.transport.error`。
- `transport.nodes[]` 是静态表；0.6 不做自动发现。
- 远端事件缺 `tenant_id` 时回灌按 default 归属，需 gateway 保证租户字段。
- 监听 `0.0.0.0` 时 banner / `hello.node.endpoint` 仍显示 `http://0.0.0.0:<port>`；实际访问需换成真实 IP / 域名（并匹配证书 SAN）。
- `--connect-token` 会出现在进程参数列表中；生产优先用 env 或文件权限受控的 config。
- 0.6.1 已修复：durable 端点按 tenant / 角色收紧，team REST 复用 `ROLE_RANK`，双向节点事件回声抑制，远端 spawn 成员隔离与限额对齐。

## 7. 验证清单

```bash
# 1. 证书与健康探针（不要用 -k）
curl --cacert /etc/vessel/ca.pem https://node-b.example.com:8642/health

# 2. 远程客户端
VESSEL_CONNECT_TOKEN='<token>' bun run src/cli.ts \
  --connect https://node-b.example.com:8642 \
  --ca /etc/vessel/ca.pem --run "hello"

# 3. 跨节点 team（需要 team.enabled: true 与 transport.kind: remote）
#    在 REPL 中执行 team_status { "node": "node-b" }

# 4. 离线门禁
bun test src/__tests__/connect-e2e-0.6.test.ts
bun test src/__tests__/remote-transport-e2e-0.6.test.ts
bun test packages/serve/__tests__/gateway.origin.test.ts
bun test packages/serve/__tests__/gateway.tls.test.ts
```
