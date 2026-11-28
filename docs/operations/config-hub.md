---
title: hub 与 attention 配置
kind: current
triggers: [hub, attention, direction, join_code, pairing, hub start, hub join, auto_start, public_url, data_plane, attention.nodes, tokenEnv, 联邦, 多节点]
paths: [packages/config/src/validator.ts, src/federation/attention-client.ts, src/federation/attention-nodes.ts]
---

# hub 与 attention 配置

> hub / attention 配置项运维手册。联邦机制（指针推送 / 配对 / token 签发）家见
> [federation-hub.md](../architecture/federation-hub.md)；双舰队接入见 [federation-setup](federation-setup.md)。

## `hub` 块

Hub 是**独立进程**（`vessel hub start`），不随 gateway 启动；gateway 只作为 node 出站加入远端 hub。

```yaml
hub:
  auto_start: true               # gateway 启动时自动拉起本地 hub（默认 true；direction:node 忽略）
  direction: node                # 仅 node 角色：gateway 出站加入远端 hub
  url: https://hub.example:8643  # node 角色：hub 基址（join 缺省 URL；运行时 state 优先）
  ca_file: /etc/vessel/hub-ca.pem
  join_code_env: VESSEL_HUB_JOIN_CODE   # join 缺 --code 时读取
```

- `hub` 是顶层块；`hub.data_dir`（仅 hub 进程用）与全局 `data_dir` 相同 → validation error
  `hub_data_dir_conflict`。
- `direction` 只接受 `node`：节点不需要开放入站端口。`gateway start` 在 `auto_start`（默认 true）时
  spawn `vessel hub start`，已有活实例 adopt；`gateway stop` 只停本次 spawn 的 hub。
  `direction: node` 时网关不启动本地 hub。
- `url` 必须绝对 http(s)、无 userinfo/path/query/hash，非回环必须 https；`join_code_env` 只在
  `vessel hub join` 缺 `--code` 时读取。node token 明文**只走 SecretStore**。
- node 侧状态写 gateway 的 `data_dir`（`hub-node.json` / `hub-node-status.json`），不写 `hub.data_dir`。
- hub 进程非回环 `hub.listen.hostname` 必须 `allow_remote: true` + TLS cert/key + 非空 `token_env`；
  不提供 `--insecure`。`hub` 不接受明文 `token`，只允许 `token_env`；`allow_file_secrets`（默认 false）
  才允许 SecretStore 不可用时回退 AES-256-GCM 文件，否则 fail-closed。
- `pairing_ttl_seconds`（默认 300，范围 60–3600）：一次性 join code 有效期；码只存 hash、先烧后用。
  `vessel hub join-code` 在 hub 侧生成，`vessel hub join` 在节点侧消费；hub 签发 `scope: node` token
  只存 sha256。旧 `hub pair` / `hub node add` / `hub token *` / `hub data-token` 已删除。
- hub 只推 `{node_id, team_id, request_id?, reason, ts}` 指针，**不代理正文**；节点离线保留最后快照。
- **NAT 数据面**：`direction: node` 只保证元数据可达；无浏览器可达地址的节点需隧道/反代，可用
  `public_url` 声明节点 origin；`data_plane: direct|unreachable` 由 `public_url ?? url` 派生。
- **已知限制**：跨节点 A2A、多 hub 联邦、hub daemon 注册未实现；一个 node 进程/data dir 只加入一个 hub。

## `attention.nodes[]`（多节点应答）

```yaml
attention:
  nodes:
    - name: node-b
      url: https://node-b.example.com:8642
      tokenEnv: NODE_B_ATTENTION_TOKEN
      nodeId: node-b-...      # 可选；配置后每次使用前 health.get 校验
      caFile: ./ca.pem        # 可选
```

- `name` 唯一；`url` 走绝对 http(s) / 非回环 HTTPS 规则。**不接受内联 `token`**（未知键报错）；
  token 只从该节点 `tokenEnv` 读，不回退 `connect.token` / `node.token` / `VESSEL_CONNECT_TOKEN`。
- `vessel attention --node <name>` 使用该节点；`--all-nodes` 逐节点并发、只用于列表，单节点失败
  不影响其它（任一失败 exit 1）；`--to` 多匹配必须显式 `--node`。应答必须落到单个节点，不跨节点批量。

## hub CLI

```bash
vessel hub start [--host <h>] [--port <p>] [--data-dir <hubDir>] [--allow-remote]
vessel hub directory [--hub-url <url>] [--json]
vessel hub watch [--hub-url <url>]
vessel hub join-code [--data-dir <dir>] [--ttl <s>] [--json]
vessel hub join [<hub-url>] --code <CODE> [--public-url <url>] [--ca <file>] [--json]
vessel hub node list [--json]
vessel hub node remove <pairing_id>
```

token 明文只在 `hub join` 响应出现一次，不写日志。