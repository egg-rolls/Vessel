---
title: 跨机器远程连接（--connect 与两机配置）
kind: current
triggers: [远程, 远程运维, 跨机器, 多机部署, connect, 两机, node token, 令牌, 非回环, 派生, 排障, 401, data_locked, 权限交互]
paths: [src/cli/args.ts, src/rpc/http-client.ts, packages/config/src/root-secret.ts, src/gateway/serve-auth.ts]
---

# 跨机器远程连接（--connect 与两机配置）

> 远程与 Hub 出站都必须显式 opt-in；缺省平台绑 `127.0.0.1:8642`、Node API 绑 `127.0.0.1:8644`、明文。
> 协议 / TLS 规则见 [architecture/gateway.md](../architecture/gateway.md#tls)（ADR-051/052/053/101）；
> 证书与 CA 见 [remote-tls](remote-tls.md)；同机反代见 [proxy-secret](proxy-secret.md)。一个 node 服务一个公司，无 tenant 选择。

## 安全边界（fail-closed）

- 非回环访问必须同时具备 **token** 与 **HTTPS/WSS**；缺一即失败，不回退匿名或明文。
- 无逃生口：不提供 `--insecure` / `-k`；失败信息区分 token 401、Origin 403、TLS 校验失败与网络错误。
- token 不进 URL：WS 首帧 `{kind:'auth', token, since?}`；HTTP 用 `Authorization: Bearer`；不写日志。
- Origin allowlist：`node.allowed_origins` 只接受显式 `http(s)://host[:port]`，拒绝 `*` / path / query；
  HTTP 与 WS upgrade 共用（见 [config-origins](config-origins.md)）。
- per-node token：平台 `gateway.token(s)` 与 node `node.token(s)` 分开，互不回退；
  `--connect` 用**节点 token**。`node.tokens` 条目只含 `role`（read / write / admin）。

## node-b：暴露 Node API

`serve:` 块已移除：写 `serve:` = 启动失败（exit 2），整块改名 `node:` 字段不变（见 [config-files](config-files.md)）。

```yaml
# ~/.vessel/config.yaml（node-b）
host:
  node_id: node-b
node:
  hostname: 0.0.0.0
  port: 8644
  allow_remote: true
  token_env: VESSEL_NODE_TOKEN
  tls:
    cert_file: /etc/vessel/node-b-cert.pem
    key_file: /etc/vessel/node-b-key.pem
```

平台监听另配 `gateway:`（回环 + `token_env`），见 [exposure-hardening](exposure-hardening.md)。

```bash
export VESSEL_NODE_TOKEN='<node-b-token>'
vessel node start --config /etc/vessel/node-b.yaml   # daemon 加 --daemon
```

- `host.node_id` 必须唯一；federation peer 的 `node_id` 必须与它一致。
- **一个 token 都不用写**：未显式配置时 node 从 `<dataDir>/root-secret` 派生 `vessel:node:<node_id>`；
  对**非回环**客户端派生值就是必须出示的凭据（缺/错 401），**回环匿名语义不变**；只有显式配置才
  收紧回环（`serve-auth.ts`；规则见 [config-secrets](config-secrets.md)）。读出派生值：
  `vessel token show --purpose node --node node-b`（只回环 + 交互式终端打印）。
- 分角色：`node.tokens: { "<read-token>": { role: read }, "<write-token>": { role: write } }`。

## node-a：远程客户端

```bash
export VESSEL_CONNECT_TOKEN='<node-b-token>'
vessel --connect https://node-b.example.com:8644 --ca /etc/vessel/ca.pem --run "hello"
```

等价配置：`connect.token_env: VESSEL_CONNECT_TOKEN` + `connect.ca_file: /etc/vessel/ca.pem`。

- token 优先级：`--connect-token` > env（`VESSEL_CONNECT_TOKEN` 或 `connect.token_env`）> `connect.token`。
- `--connect` / `VESSEL_CONNECT` 只接受 origin；回环允许 `http://`，非回环必须 `https://`。
- 建连后 `health.get` 取远端 node 身份（stderr 打印 `Remote gateway: node=...`）；
  connect 模式不获取本地 data-dir 写意图锁、不写本地 store / trace。
- 跨节点投递只有 federation（`/v1/team/*` / RemoteTransport 已删除）；寻址与协议见
  [federation-hub](../architecture/federation-hub.md)，接入见 [federation-pairing](federation-pairing.md)。

## token 词表（文档 / help / 错误消息不用裸 "token"）

| 词 | 认证谁 | 用途 |
|---|---|---|
| gateway token | 用户 / 管理员 | 平台 `/platform/rpc` 与 UI |
| node token | 用户 / 管理员 | Node API canonical RPC / WS |
| team token | 限定 team 的用户 | 只能操作自己的 team |
| owner token | 本机 REPL owner | 本机 owner 端点（loopback） |
| peer token | 节点 | `/v1/federation/*`，**不能答权限** |
| hub token | hub / node | hub 目录 / 控制面 |

## 远程权限交互

- permission / ask 只在运行 agent 的节点本地应答；`answered_by` 只接受 `human | policy`。
  权限等待**默认不超时**：直到应答、取消或 run abort；`expired` 只在确已过期时返回，
  `run_ended` = run 已结束或记录 orphaned。
- 多端连接同一 gateway 共享持久化状态（重启后旧 pending 转 orphaned，重复应答幂等、不同决定
  conflict）——文件与终态规则见 [config-permission](config-permission.md)。
- 独立前端：权限 / ask 卡片内联在所属 run，跨 session 待处理在顶部条提示；其他端应答 / 过期 /
  run 终态自动收起。

## 验证与排障（只写不跑）

```bash
curl --cacert /etc/vessel/ca.pem https://node-b.example.com:8644/health   # 不要用 -k
VESSEL_CONNECT_TOKEN='<token>' vessel --connect https://node-b.example.com:8644 --ca /etc/vessel/ca.pem --run "hello"
```

| 现象 | 处理 |
|---|---|
| HTTP 401 `unauthorized` | 检查 `--connect-token` / env / `node.tokens`；浏览器数据面 401 分流见 [TROUBLESHOOTING-401](TROUBLESHOOTING-401.md) |
| HTTP 403 `forbidden` | Origin 不在 allowlist 或 token role 不足 |
| WS 关闭 4401 | 首帧 auth 缺失或超 5s；token 不能放 URL |
| `data_locked` | 同一 dataDir 另一写者占用；停掉占用进程或改用 `--connect`，不删活跃锁 |
| `non_root_layout` | 存在非空 `<dataDir>/tenants/**`；先归档再根布局启动（见 [MIGRATION](MIGRATION.md)） |
| TLS / 证书错误 | 见 [remote-tls](remote-tls.md) |

已知限制：`--connect-token` 会出现在进程参数列表（生产优先 env / 受控 config）；多 node 场景
`gateway reload` 走全局 node 监听缺省 8644，按节点操作用 `node reload` / 直连；事件缓冲截断按 `since`
续订（[gateway.md](../architecture/gateway.md#protocol)）。生命周期命令见 [GATEWAY](GATEWAY.md)。